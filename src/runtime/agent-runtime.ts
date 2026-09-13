import { RuntimeError } from "../errors/runtime-errors.js";
import type { RuntimeEventBus } from "../events/runtime-events.js";
import {
  assertNonEmptyValue,
  assertRuntimeStarted
} from "../guards/runtime-guards.js";
import type { RuntimeTask, TaskExecutionResult } from "../tasks/task-types.js";
import type { ToolDefinition } from "../tools/types.js";
import { createRuntimeDependencies } from "./bootstrap.js";
import type { RuntimeContext } from "./context.js";
import type { RuntimeOptions } from "./types.js";

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
  private readonly inFlightPromises = new Map<string, Promise<unknown>>();
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
    this.dependencies.logger.info("Runtime started.", {
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

    this.stopped = true;
    this.started = false;

    const drainStartedAt = Date.now();
    let strandedTaskIds: string[] | undefined;
    const drainRequested =
      options.drainTimeoutMs !== undefined && options.drainTimeoutMs > 0;

    if (drainRequested) {
      await this.awaitInFlightTasks(options.drainTimeoutMs as number);
      if (this.inFlightTasks.size > 0) {
        strandedTaskIds = Array.from(this.inFlightTasks);
        const elapsedDrainMs = Date.now() - drainStartedAt;
        this.dependencies.logger.warn(
          `Tasks still in flight after drain timeout: ${strandedTaskIds.join(", ")}`,
          {
            runtimeId: this.runtimeId,
            inFlightTaskCount: strandedTaskIds.length,
            inFlightTasks: strandedTaskIds,
            strandedTasks: strandedTaskIds,
            drainTimeoutMs: options.drainTimeoutMs,
            elapsedDrainMs
          }
        );
      }
    }

    const drainDurationMs = Date.now() - drainStartedAt;

    if (strandedTaskIds !== undefined && strandedTaskIds.length > 0) {
      this.dependencies.logger.warn(
        "Runtime stopped with stranded in-flight tasks.",
        {
          runtimeId: this.runtimeId,
          strandedTaskIds,
          drainDurationMs
        }
      );
    } else {
      this.dependencies.logger.info("Runtime stopped.", {
        runtimeId: this.runtimeId,
        drainDurationMs
      });
    }

    // The runtime is stopped and cannot accept new work. Clearing these
    // tracking collections does not cancel caller-owned task promises; their
    // finally blocks remain safe when they eventually settle.
    this.inFlightTasks.clear();
    this.inFlightPromises.clear();

    const stoppedPayload: RuntimeStoppedPayload = {
      runtimeId: this.runtimeId,
      occurredAt: new Date().toISOString(),
      drainDurationMs
    };
    if (strandedTaskIds !== undefined && strandedTaskIds.length > 0) {
      stoppedPayload.strandedTaskIds = strandedTaskIds;
    }

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
   * Execute a task on the runtime.
   *
   * Task IDs must be unique while in flight. Attempting to start a task with
   * a `taskId` that is already actively running rejects before lifecycle
   * events are emitted for the duplicate request.
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

    this.dependencies.eventBus.emit({
      name: "runtime.task.received",
      payload: {
        runtimeId: this.runtimeId,
        taskId: task.taskId,
        agentId: task.agentId
      }
    });

    this.dependencies.logger.info("Executing runtime task.", {
      runtimeId: this.runtimeId,
      taskId: task.taskId,
      toolName: task.toolName
    });

    this.inFlightTasks.add(task.taskId);

    const taskPromise = (async (): Promise<TaskExecutionResult<TResult>> => {
      try {
        const result = await this.dependencies.taskRunner.run<TPayload, TResult>(
          task,
          context
        );

        this.dependencies.logger.info("Runtime task completed.", {
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

        this.dependencies.logger.error("Runtime task failed.", {
          runtimeId: this.runtimeId,
          taskId: task.taskId,
          toolName: task.toolName,
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
        this.inFlightTasks.delete(task.taskId);
        this.inFlightPromises.delete(task.taskId);
      }
    })();

    this.inFlightPromises.set(task.taskId, taskPromise);
    return taskPromise;
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
    const settled = Promise.allSettled(promises).then(() => undefined);

    try {
      await Promise.race([settled, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /** Legacy hook retained for regression instrumentation; draining is promise-based. */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
