import { RuntimeError } from "../errors/runtime-errors.js";
import type { RuntimeEventBus } from "../events/runtime-events.js";
import {
  assertNonEmptyValue,
  assertRuntimeStarted
} from "../guards/runtime-guards.js";
import type { TaskOutcomeReconciliationReceipt } from "../tasks/task-outcome-reconciliation.js";
import type { RuntimeTask, TaskExecutionResult } from "../tasks/task-types.js";
import type { ToolDefinition } from "../tools/types.js";
import { createRuntimeDependencies } from "./bootstrap.js";
import type { RuntimeContext } from "./context.js";
import type { RuntimeOptions } from "./types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface RuntimeStopOptions {
  clearListeners?: boolean;
  drainTimeoutMs?: number;
}

export interface RuntimeStoppedPayload {
  runtimeId: string;
  occurredAt: string;
  strandedTaskIds?: string[];
  drainDurationMs?: number;
}

export class AgentRuntime {
  private readonly dependencies: ReturnType<typeof createRuntimeDependencies>;
  private readonly runtimeId: string;
  private readonly inFlightTasks = new Set<string>();
  private readonly inFlightPromises = new Map<string, Promise<void>>();
  private started = false;
  private stopped = false;

  public constructor(options: RuntimeOptions) {
    this.runtimeId = options.runtimeId;
    this.dependencies = createRuntimeDependencies(options);
  }

  public registerTool<TPayload, TResult>(
    tool: ToolDefinition<TPayload, TResult>
  ): void {
    this.dependencies.toolRegistry.register(tool);
  }

  public isRunning(): boolean {
    return this.started;
  }

  public getInFlightTaskCount(): number {
    return this.inFlightTasks.size;
  }

  public listTools(): ToolDefinition[] {
    return this.dependencies.toolRegistry.list();
  }

  public getDependencies() {
    return this.dependencies;
  }

  public async start(): Promise<void> {
    if (this.started) {
      throw new RuntimeError(
        "RUNTIME_ALREADY_STARTED",
        "AgentRuntime has already been started."
      );
    }
    if (this.stopped) {
      throw new RuntimeError(
        "RUNTIME_ALREADY_STOPPED",
        "AgentRuntime has already been stopped and cannot be restarted."
      );
    }

    this.started = true;
    this.logSafely("info", "Runtime started.", {
      runtimeId: this.runtimeId
    });
    this.dependencies.eventBus.emit({
      name: "runtime.started",
      payload: {
        runtimeId: this.runtimeId,
        occurredAt: new Date().toISOString()
      }
    });
  }

  public async stop(options: RuntimeStopOptions = {}): Promise<void> {
    if (!this.started || this.stopped) {
      return;
    }

    const drainTimeoutMs = options.drainTimeoutMs;
    if (
      drainTimeoutMs !== undefined &&
      (!Number.isInteger(drainTimeoutMs) ||
        drainTimeoutMs < 0 ||
        drainTimeoutMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new RangeError(
        `drainTimeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`
      );
    }

    this.stopped = true;
    this.started = false;

    const drainStartMs = Date.now();
    let strandedTaskIds: string[] = [];

    if (drainTimeoutMs !== undefined) {
      if (drainTimeoutMs > 0) {
        await this.awaitInFlightTasks(drainTimeoutMs);
      }

      if (this.inFlightTasks.size > 0) {
        strandedTaskIds = Array.from(this.inFlightTasks);
      }
    }

    // Runtime shutdown is terminal. Tasks that outlive an explicit drain timeout
    // keep their own promises, but are no longer reported as runtime-owned work.
    this.inFlightTasks.clear();
    this.inFlightPromises.clear();

    const drainDurationMs = Date.now() - drainStartMs;

    if (strandedTaskIds.length > 0) {
      this.logSafely(
        "warn",
        `Runtime stopped with stranded in-flight tasks. Tasks still in flight after drain timeout: ${strandedTaskIds.join(", ")}`,
        {
          runtimeId: this.runtimeId,
          strandedTaskIds,
          strandedTasks: strandedTaskIds,
          inFlightTasks: strandedTaskIds,
          inFlightTaskCount: strandedTaskIds.length,
          drainTimeoutMs,
          elapsedDrainMs: drainDurationMs,
          drainDurationMs
        }
      );
    } else {
      this.logSafely("info", "Runtime stopped.", {
        runtimeId: this.runtimeId,
        drainDurationMs
      });
    }

    const stoppedPayload: RuntimeStoppedPayload = {
      runtimeId: this.runtimeId,
      occurredAt: new Date().toISOString(),
      drainDurationMs
    };
    if (strandedTaskIds.length > 0) {
      stoppedPayload.strandedTaskIds = strandedTaskIds;
    }

    // Publish one terminal lifecycle event before optionally clearing listeners.
    this.dependencies.eventBus.emit({
      name: "runtime.stopped",
      payload: stoppedPayload
    });

    if (options.clearListeners === true) {
      const eventBus = this.dependencies.eventBus as RuntimeEventBus & {
        clear?: () => void;
      };
      eventBus.clear?.();
    }
  }

  /**
   * Release an unknown-outcome tombstone only after the configured authority
   * proves that the external side effect was not applied and the prior attempt
   * can no longer commit. Opaque evidence is passed only to that authority.
   */
  public async reconcileUnknownOutcome(
    taskId: string,
    evidence: unknown
  ): Promise<TaskOutcomeReconciliationReceipt> {
    assertRuntimeStarted(this.started);
    assertNonEmptyValue(taskId, "taskId");

    if (this.inFlightTasks.has(taskId)) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_CONFLICT",
        `Task "${taskId}" is still reserved by this runtime and cannot be reconciled.`,
        { taskId }
      );
    }

    const receipt = await this.dependencies.taskRunner.reconcileUnknownOutcome(
      taskId,
      evidence
    );

    this.logSafely("info", "Unknown task outcome reconciled for safe retry.", {
      runtimeId: this.runtimeId,
      taskId,
      claimId: receipt.claimId,
      authorityReference: receipt.authorityReference,
      evidenceSha256: receipt.evidenceSha256
    });
    this.dependencies.eventBus.emit({
      name: "runtime.task.reconciled",
      payload: {
        runtimeId: this.runtimeId,
        ...receipt
      }
    });

    return receipt;
  }

  /**
   * Execute a task on the runtime.
   *
   * Task IDs are unique while their underlying tool invocation is active. A
   * completed or failed task ID may be reused after that invocation settles,
   * but a concurrent duplicate is rejected before lifecycle side effects.
   */
  public async executeTask<TPayload, TResult>(
    task: RuntimeTask<TPayload>
  ): Promise<TaskExecutionResult<TResult>> {
    assertRuntimeStarted(this.started);
    assertNonEmptyValue(task.taskId, "taskId");
    assertNonEmptyValue(task.agentId, "agentId");
    assertNonEmptyValue(task.toolName, "toolName");
    assertNonEmptyValue(task.input, "input");

    if (this.inFlightTasks.has(task.taskId)) {
      throw new RuntimeError(
        "DUPLICATE_IN_FLIGHT_TASK",
        `Task "${task.taskId}" is already in flight.`,
        { taskId: task.taskId }
      );
    }

    const agent = this.dependencies.agentManager.getOrCreate(task.agentId);
    const context: RuntimeContext = {
      runtimeId: this.runtimeId,
      taskId: task.taskId,
      agent,
      memory: this.dependencies.memoryStore,
      modelProvider: this.dependencies.modelProvider,
      state: this.dependencies.stateStore,
      now: new Date().toISOString()
    };

    // Reserve the task ID synchronously before publishing the received event so
    // a listener cannot re-enter executeTask() with the same active ID.
    this.inFlightTasks.add(task.taskId);

    let resolveInFlight!: () => void;
    const inFlightPromise = new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    });
    this.inFlightPromises.set(task.taskId, inFlightPromise);

    try {
      this.dependencies.eventBus.emit({
        name: "runtime.task.received",
        payload: {
          runtimeId: this.runtimeId,
          taskId: task.taskId,
          agentId: task.agentId
        }
      });

      this.logSafely("info", "Executing runtime task.", {
        runtimeId: this.runtimeId,
        taskId: task.taskId,
        toolName: task.toolName
      });

      const result = await this.dependencies.taskRunner.run<TPayload, TResult>(
        task,
        context
      );

      this.logSafely("info", "Runtime task completed.", {
        runtimeId: this.runtimeId,
        taskId: task.taskId,
        toolName: task.toolName,
        durationMs: result.durationMs
      });

      this.dependencies.eventBus.emit({
        name: "runtime.task.completed",
        payload: {
          runtimeId: this.runtimeId,
          taskId: task.taskId,
          agentId: task.agentId,
          toolName: task.toolName,
          durationMs: result.durationMs
        }
      });

      return result;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Unknown runtime failure.";

      this.logSafely("error", "Runtime task failed.", {
        runtimeId: this.runtimeId,
        taskId: task.taskId,
        reason
      });
      this.dependencies.eventBus.emit({
        name: "runtime.task.failed",
        payload: {
          runtimeId: this.runtimeId,
          taskId: task.taskId,
          agentId: task.agentId,
          reason
        }
      });

      throw error;
    } finally {
      const releaseTask = (): void => {
        // Tool-call budgets are scoped to one underlying tool lifecycle. In the
        // timeout case, do not reset the budget or release the reusable task ID
        // while the original side-effecting invocation is still running.
        this.dependencies.actionExecutor.reset(task.taskId);

        // Guard the deferred release so a terminal stop or future refactor cannot
        // let an old settlement callback delete a different reservation.
        if (this.inFlightPromises.get(task.taskId) === inFlightPromise) {
          this.inFlightTasks.delete(task.taskId);
          this.inFlightPromises.delete(task.taskId);
          resolveInFlight();
        }
      };

      const activeExecution =
        this.dependencies.taskRunner.getActiveExecution(task.taskId);
      if (activeExecution === undefined) {
        releaseTask();
      } else {
        // A deadline can reject TaskRunner.run() before the tool promise settles.
        // Preserve duplicate-task and shutdown-drain custody until it does.
        void activeExecution.then(releaseTask);
      }
    }
  }

  private logSafely(
    level: "info" | "warn" | "error",
    message: string,
    metadata: Record<string, unknown>
  ): void {
    try {
      this.dependencies.logger[level](message, metadata);
    } catch {
      // Runtime logging is observational. A custom logger failure must not
      // change lifecycle state, task success/failure, or the original error.
    }
  }

  private async awaitInFlightTasks(timeoutMs: number): Promise<void> {
    const promises = Array.from(this.inFlightPromises.values());
    if (promises.length === 0) {
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs);
    });

    try {
      await Promise.race([Promise.all(promises).then(() => undefined), timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
