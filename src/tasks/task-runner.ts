import type { ActionExecutor } from "../actions/action-executor.js";
import { RuntimeError } from "../errors/runtime-errors.js";
import { assertNonEmptyValue } from "../guards/runtime-guards.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { RuntimeContext } from "../runtime/context.js";
import {
  InMemoryTaskOutcomeStore,
  type TaskOutcomeStore
} from "./task-outcome-store.js";
import type { RuntimeTask, TaskExecutionResult } from "./task-types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class TaskRunner {
  private readonly actionExecutor: ActionExecutor;
  private readonly memoryStore: MemoryStore;
  private readonly taskOutcomeStore: TaskOutcomeStore;
  private readonly timeoutMs: number | undefined;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly unknownOutcomeTaskIds = new Set<string>();

  public constructor(
    actionExecutor: ActionExecutor,
    memoryStore: MemoryStore,
    timeoutMs?: number,
    taskOutcomeStore: TaskOutcomeStore = new InMemoryTaskOutcomeStore()
  ) {
    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new RangeError(
        `TaskRunner timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`
      );
    }

    this.actionExecutor = actionExecutor;
    this.memoryStore = memoryStore;
    this.taskOutcomeStore = taskOutcomeStore;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Returns a settlement-only promise while the underlying tool invocation for
   * a task ID is still executing. A timeout may reject the public task before
   * this promise settles; callers can use it to retain lifecycle custody until
   * the tool itself has actually stopped running.
   */
  public getActiveExecution(taskId: string): Promise<void> | undefined {
    return this.activeExecutions.get(taskId);
  }

  public async run<TPayload, TResult>(
    task: RuntimeTask<TPayload>,
    context: RuntimeContext
  ): Promise<TaskExecutionResult<TResult>> {
    assertNonEmptyValue(task.taskId, "taskId");
    assertNonEmptyValue(task.agentId, "agentId");
    assertNonEmptyValue(task.toolName, "toolName");
    assertNonEmptyValue(task.input, "input");

    if (task.taskId !== context.taskId) {
      throw new RuntimeError(
        "INVALID_TASK",
        "task.taskId must match context.taskId.",
        { taskId: task.taskId, contextTaskId: context.taskId }
      );
    }

    const contextAgentId = context.agent?.agentId;
    if (task.agentId !== contextAgentId) {
      throw new RuntimeError(
        "INVALID_TASK",
        "task.agentId must match context.agent.agentId.",
        { agentId: task.agentId, contextAgentId }
      );
    }

    if (this.unknownOutcomeTaskIds.has(task.taskId)) {
      throw this.unknownOutcomeError(task.taskId);
    }

    const startedAt = new Date().toISOString();
    let beginResult: Awaited<ReturnType<TaskOutcomeStore["begin"]>>;
    try {
      beginResult = await this.taskOutcomeStore.begin(
        task.agentId,
        task.taskId,
        startedAt
      );
    } catch (error) {
      throw new RuntimeError(
        "EXECUTION_FAILED",
        error instanceof Error
          ? error.message
          : "Could not establish durable task intent.",
        error instanceof Error ? { cause: error.message } : undefined
      );
    }

    if (beginResult === "unknown") {
      this.unknownOutcomeTaskIds.add(task.taskId);
      throw this.unknownOutcomeError(task.taskId);
    }

    const startTime = performance.now();
    let output: TResult;
    try {
      output = await this.executeWithTimeout<TPayload, TResult>(
        task.toolName,
        task.payload,
        context
      );
    } catch (error) {
      if (!this.unknownOutcomeTaskIds.has(task.taskId)) {
        try {
          await this.taskOutcomeStore.complete(
            task.agentId,
            task.taskId,
            new Date().toISOString()
          );
        } catch {
          this.unknownOutcomeTaskIds.add(task.taskId);
        }
      }
      throw error;
    }

    const endTime = performance.now();
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Math.round(endTime - startTime));

    try {
      await this.memoryStore.append({
        agentId: task.agentId,
        taskId: task.taskId,
        input: task.input,
        output,
        recordedAt: completedAt
      });
    } catch (error) {
      this.unknownOutcomeTaskIds.add(task.taskId);
      throw new RuntimeError(
        "EXECUTION_FAILED",
        error instanceof Error ? error.message : "Task execution failed.",
        error instanceof Error ? { cause: error.message } : undefined
      );
    }

    try {
      await this.taskOutcomeStore.complete(
        task.agentId,
        task.taskId,
        completedAt
      );
    } catch (error) {
      this.unknownOutcomeTaskIds.add(task.taskId);
      throw new RuntimeError(
        "EXECUTION_FAILED",
        error instanceof Error
          ? error.message
          : "Could not persist completed task outcome.",
        error instanceof Error ? { cause: error.message } : undefined
      );
    }

    return {
      taskId: task.taskId,
      agentId: task.agentId,
      toolName: task.toolName,
      output,
      startedAt,
      completedAt,
      durationMs
    };
  }

  private unknownOutcomeError(taskId: string): RuntimeError {
    return new RuntimeError(
      "TASK_OUTCOME_UNKNOWN",
      `Task "${taskId}" cannot be retried safely because its durable outcome is unknown after a previous execution.`,
      { taskId }
    );
  }

  private async executeWithTimeout<TPayload, TResult>(
    toolName: string,
    payload: TPayload,
    context: RuntimeContext
  ): Promise<TResult> {
    const execution = this.actionExecutor.execute<TPayload, TResult>(
      toolName,
      payload,
      context
    );

    const settlement = execution.then(
      () => undefined,
      () => undefined
    );
    this.activeExecutions.set(context.taskId, settlement);
    void settlement.then(() => {
      if (this.activeExecutions.get(context.taskId) === settlement) {
        this.activeExecutions.delete(context.taskId);
      }
    });

    const timeoutMs = this.timeoutMs;

    if (timeoutMs === undefined) {
      return execution;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        this.unknownOutcomeTaskIds.add(context.taskId);
        reject(
          new RuntimeError(
            "EXECUTION_FAILED",
            `Task execution timed out after ${timeoutMs}ms.`,
            { timeoutMs }
          )
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([execution, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
