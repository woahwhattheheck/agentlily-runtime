import type { ActionExecutor } from "../actions/action-executor.js";
import { RuntimeError } from "../errors/runtime-errors.js";
import { assertNonEmptyValue } from "../guards/runtime-guards.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { RuntimeContext } from "../runtime/context.js";
import {
  InMemoryTaskClaimStore,
  type TaskClaimStore
} from "./task-claim-store.js";
import type { RuntimeTask, TaskExecutionResult } from "./task-types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class TaskRunner {
  private readonly actionExecutor: ActionExecutor;
  private readonly memoryStore: MemoryStore;
  private readonly taskClaimStore: TaskClaimStore;
  private readonly timeoutMs: number | undefined;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly unknownOutcomeTaskIds = new Set<string>();

  public constructor(
    actionExecutor: ActionExecutor,
    memoryStore: MemoryStore,
    timeoutMs?: number,
    taskClaimStore: TaskClaimStore = new InMemoryTaskClaimStore()
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
    this.taskClaimStore = taskClaimStore;
    this.timeoutMs = timeoutMs;
  }

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

    // The claim is durable before tool invocation. A prior process that died
    // after an external side effect but before result persistence therefore
    // leaves a tombstone that a fresh runtime can observe before re-execution.
    const claimed = await this.taskClaimStore.claim(task.taskId);
    if (!claimed) {
      this.unknownOutcomeTaskIds.add(task.taskId);
      throw this.unknownOutcomeError(task.taskId);
    }

    const startTime = performance.now();
    const startedAt = new Date().toISOString();

    let output: TResult;
    try {
      output = await this.executeWithTimeout<TPayload, TResult>(
        task.toolName,
        task.payload,
        context
      );
    } catch (error) {
      // Timeout is ambiguous because the underlying promise may keep running.
      // Ordinary tool rejection retains the historical retry contract.
      if (!this.unknownOutcomeTaskIds.has(task.taskId)) {
        await this.releaseClaimSafely(task.taskId);
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
      // Keep the already-durable pre-execution claim. The tool resolved before
      // persistence failed, so retrying this logical ID could repeat a side effect.
      this.unknownOutcomeTaskIds.add(task.taskId);
      throw new RuntimeError(
        "EXECUTION_FAILED",
        error instanceof Error ? error.message : "Task execution failed.",
        error instanceof Error ? { cause: error.message } : undefined
      );
    }

    // Once the result is durable the outcome is known and deliberate ID reuse
    // remains supported. Cleanup failure is fail-closed rather than executable.
    await this.releaseClaimSafely(task.taskId);

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

  private async releaseClaimSafely(taskId: string): Promise<void> {
    try {
      await this.taskClaimStore.release(taskId);
      this.unknownOutcomeTaskIds.delete(taskId);
    } catch {
      // If cleanup cannot be proven, retain the local tombstone too. A durable
      // store that failed to release should still contain its original claim.
      this.unknownOutcomeTaskIds.add(taskId);
    }
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
        // A JavaScript timeout does not cancel an arbitrary tool promise. Keep
        // the pre-execution claim so this or a restarted runtime cannot duplicate
        // an outcome that may already have happened externally.
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
