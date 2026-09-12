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

    const drainStartMs = Date.now();
    const shouldDrain =
      options.drainTimeoutMs !== undefined && options.drainTimeoutMs > 0;

    if (shouldDrain) {
      await this.awaitInFlightTasks(options.drainTimeoutMs as number);
    }

    const strandedTaskIds =
      shouldDrain && this.inFlightTasks.size > 0
        ? Array.from(this.inFlightTasks)
        : [];
    const drainDurationMs = Date.now() - drainStartMs;

    if (strandedTaskIds.length > 0) {
      this.dependencies.logger.warn(
        `Runtime stopped with stranded in-flight tasks. Tasks still in flight after drain timeout: ${strandedTaskIds.join(", ")}`,
        {
          runtimeId: this.runtimeId,
          strandedTaskIds,
          strandedTasks: strandedTaskIds,
          inFlightTasks: strandedTaskIds,
          inFlightTaskCount: strandedTaskIds.length,
          drainTimeoutMs: options.drainTimeoutMs,
          elapsedDrainMs: drainDurationMs,
          drainDurationMs
        }
      );
    } else {
      this.dependencies.logger.info("Runtime stopped.", {
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

    // The runtime is no longer admitting work. Clear tracking even if a task
    // outlives the drain deadline; its own finally block remains safe to run.
    this.inFlightTasks.clear();
    this.inFlightPromises.clear();

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
   * Task IDs must be unique while in flight. Attempting to start a task with a
   * taskId that is already actively running rejects before lifecycle emission.
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

    // Reserve the ID before lifecycle callbacks run so a re-entrant listener
    // cannot admit a second task with the same ID.
    this.inFlightTasks.add(task.taskId);

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

    const taskPromise = (async () => {
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
        const reason = error instanceof Error ? error.message : String(error);
        this.dependencies.logger.error("Runtime task failed.", {
          runtimeId: this.runtimeId,
          taskId: task.taskId,
          toolName: task.toolName,
          error
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

    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    });

    await Promise.race([Promise.all(promises), timeout]);
  }
}
