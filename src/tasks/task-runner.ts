import type { ActionExecutor } from "../actions/action-executor.js";
import { RuntimeError } from "../errors/runtime-errors.js";
import { assertNonEmptyValue } from "../guards/runtime-guards.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { RuntimeContext } from "../runtime/context.js";
import {
  InMemoryTaskClaimStore,
  type TaskClaimStore
} from "./task-claim-store.js";
import type {
  TaskOutcomeReconciliationAuthority,
  TaskOutcomeReconciliationDecision,
  TaskOutcomeReconciliationReceipt
} from "./task-outcome-reconciliation.js";
import type { RuntimeTask, TaskExecutionResult } from "./task-types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_AUDIT_REFERENCE = /^[\x20-\x7e]{1,512}$/;

const parseReconciliationDecision = (
  value: unknown
): TaskOutcomeReconciliationDecision | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const decision = value as Record<string, unknown>;
  if (
    decision.confirmedNotApplied !== true ||
    decision.confirmedQuiescent !== true ||
    typeof decision.authorityReference !== "string" ||
    !SAFE_AUDIT_REFERENCE.test(decision.authorityReference) ||
    decision.authorityReference.trim().length === 0 ||
    typeof decision.evidenceSha256 !== "string" ||
    !SHA256_HEX.test(decision.evidenceSha256)
  ) {
    return undefined;
  }

  return {
    confirmedNotApplied: true,
    confirmedQuiescent: true,
    authorityReference: decision.authorityReference.trim(),
    evidenceSha256: decision.evidenceSha256
  };
};

export class TaskRunner {
  private readonly actionExecutor: ActionExecutor;
  private readonly memoryStore: MemoryStore;
  private readonly taskClaimStore: TaskClaimStore;
  private readonly timeoutMs: number | undefined;
  private readonly reconciliationAuthority:
    | TaskOutcomeReconciliationAuthority
    | undefined;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly unknownOutcomeTaskIds = new Set<string>();

  public constructor(
    actionExecutor: ActionExecutor,
    memoryStore: MemoryStore,
    timeoutMs?: number,
    taskClaimStore: TaskClaimStore = new InMemoryTaskClaimStore(),
    reconciliationAuthority?: TaskOutcomeReconciliationAuthority
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
    this.reconciliationAuthority = reconciliationAuthority;
  }

  public getActiveExecution(taskId: string): Promise<void> | undefined {
    return this.activeExecutions.get(taskId);
  }

  public async reconcileUnknownOutcome(
    taskId: string,
    evidence: unknown
  ): Promise<TaskOutcomeReconciliationReceipt> {
    assertNonEmptyValue(taskId, "taskId");

    if (this.activeExecutions.has(taskId)) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_CONFLICT",
        `Task "${taskId}" still has an active local execution and cannot be reconciled.`,
        { taskId }
      );
    }

    const authority = this.reconciliationAuthority;
    if (authority === undefined) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_UNAVAILABLE",
        "No task outcome reconciliation authority is configured.",
        { taskId }
      );
    }

    const inspect = this.taskClaimStore.inspect?.bind(this.taskClaimStore);
    const releaseIfMatches =
      this.taskClaimStore.releaseIfMatches?.bind(this.taskClaimStore);
    if (inspect === undefined || releaseIfMatches === undefined) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_UNAVAILABLE",
        "The configured task claim store does not support generation-bound reconciliation.",
        { taskId }
      );
    }

    const claim = await inspect(taskId);
    if (claim === undefined) {
      if (await this.taskClaimStore.has(taskId)) {
        throw new RuntimeError(
          "TASK_RECONCILIATION_UNAVAILABLE",
          `Task "${taskId}" has a legacy claim without a reconciliation generation.`,
          { taskId }
        );
      }
      throw new RuntimeError(
        "TASK_RECONCILIATION_REJECTED",
        `Task "${taskId}" has no durable unknown-outcome claim to reconcile.`,
        { taskId }
      );
    }

    let rawDecision: unknown;
    try {
      rawDecision = await authority.verifyNotApplied({
        taskId: claim.taskId,
        claimId: claim.claimId,
        claimedAt: claim.claimedAt,
        evidence
      });
    } catch {
      throw new RuntimeError(
        "TASK_RECONCILIATION_REJECTED",
        `The reconciliation authority could not verify task "${taskId}".`,
        { taskId, claimId: claim.claimId }
      );
    }

    const decision = parseReconciliationDecision(rawDecision);
    if (decision === undefined) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_REJECTED",
        `The reconciliation authority did not provide complete fail-closed proof for task "${taskId}".`,
        { taskId, claimId: claim.claimId }
      );
    }

    // A local timed-out invocation can remain alive after the first preflight.
    // Refuse to release its tombstone even if authority verification took long
    // enough for local execution state to change underneath us.
    if (this.activeExecutions.has(taskId)) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_CONFLICT",
        `Task "${taskId}" became locally active during reconciliation.`,
        { taskId, claimId: claim.claimId }
      );
    }

    const released = await releaseIfMatches(claim);
    if (released !== true) {
      throw new RuntimeError(
        "TASK_RECONCILIATION_CONFLICT",
        `Task "${taskId}" claim generation changed before reconciliation could commit.`,
        { taskId, claimId: claim.claimId }
      );
    }

    this.unknownOutcomeTaskIds.delete(taskId);
    return {
      taskId,
      claimId: claim.claimId,
      claimedAt: claim.claimedAt,
      reconciledAt: new Date().toISOString(),
      authorityReference: decision.authorityReference,
      evidenceSha256: decision.evidenceSha256,
      releasedForRetry: true
    };
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
      // The process-local marker is only a conservative cache. Another runtime
      // may have safely reconciled and released the durable generation after we
      // observed it. Revalidate against the durable authority before rejecting.
      // A storage read failure is allowed to escape and therefore fails closed.
      if (await this.taskClaimStore.has(task.taskId)) {
        throw this.unknownOutcomeError(task.taskId);
      }
      this.unknownOutcomeTaskIds.delete(task.taskId);
    }

    // The claim is durable before tool invocation. A prior process that died
    // after an external side effect but before result persistence therefore
    // leaves a tombstone that a fresh runtime can observe before re-execution.
    // If a newer generation appears between the cache refresh above and this
    // atomic claim attempt, claim() returns false and preserves the newer fence.
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
