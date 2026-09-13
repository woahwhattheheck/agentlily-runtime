import { RuntimeError } from "../errors/runtime-errors.js";
import type { RuntimeEventBus } from "../events/runtime-events.js";
import { assertMaxToolCalls } from "../guards/runtime-guards.js";
import type { RuntimeLogger } from "../logger/runtime-logger.js";
import type { ToolPolicy } from "../policies/tool-policy.js";
import type { RuntimeContext } from "../runtime/context.js";
import { ToolRegistry } from "../tools/tool-registry.js";

function resolveAgentId(
  agent: { agentId?: string; id?: string } | undefined
): string {
  return agent?.agentId ?? agent?.id ?? "";
}

export interface ActionExecutorOptions {
  maxToolCallsPerTask?: number | undefined;
  maxTrackedTasks?: number | undefined;
  logger?: RuntimeLogger | undefined;
  eventBus?: RuntimeEventBus | undefined;
  toolPolicy?: ToolPolicy | undefined;
}

export class ActionExecutor {
  private readonly toolCallCounts = new Map<string, number>();
  private readonly logger: RuntimeLogger | undefined;
  private readonly eventBus: RuntimeEventBus | undefined;
  private readonly maxToolCallsPerTask: number | undefined;
  private readonly maxTrackedTasks: number;
  private readonly toolPolicy: ToolPolicy | undefined;

  public constructor(
    private readonly toolRegistry: ToolRegistry,
    maxToolCallsPerTaskOrLogger?: number | RuntimeLogger,
    eventBus?: RuntimeEventBus,
    loggerOrMaxTrackedTasks?: RuntimeLogger | number,
    maxTrackedTasks = 1_000,
    toolPolicy?: ToolPolicy
  ) {
    let resolvedLogger: RuntimeLogger | undefined;
    let resolvedMaxTrackedTasks = maxTrackedTasks;

    if (typeof maxToolCallsPerTaskOrLogger === "number") {
      if (
        !Number.isInteger(maxToolCallsPerTaskOrLogger) ||
        maxToolCallsPerTaskOrLogger < 0
      ) {
        throw new RangeError(
          "maxToolCallsPerTask must be a non-negative integer."
        );
      }
      this.maxToolCallsPerTask = maxToolCallsPerTaskOrLogger;
    } else {
      this.maxToolCallsPerTask = undefined;
      resolvedLogger = maxToolCallsPerTaskOrLogger;
    }

    if (typeof loggerOrMaxTrackedTasks === "number") {
      resolvedMaxTrackedTasks = loggerOrMaxTrackedTasks;
    } else if (loggerOrMaxTrackedTasks !== undefined) {
      resolvedLogger = loggerOrMaxTrackedTasks;
    }

    if (
      !Number.isInteger(resolvedMaxTrackedTasks) ||
      resolvedMaxTrackedTasks < 1
    ) {
      throw new RangeError("maxTrackedTasks must be a positive integer.");
    }

    this.logger = resolvedLogger;
    this.eventBus = eventBus;
    this.maxTrackedTasks = resolvedMaxTrackedTasks;
    this.toolPolicy = toolPolicy;
  }

  public getToolCallCount(taskId: string): number {
    return this.toolCallCounts.get(taskId) ?? 0;
  }

  /** Clears the retained call budget for one completed task. */
  public reset(taskId: string): void {
    this.toolCallCounts.delete(taskId);
  }

  /** Clears all retained per-task call budgets. */
  public resetAll(): void {
    this.toolCallCounts.clear();
  }

  public async execute<TPayload, TResult>(
    toolName: string,
    payload: TPayload,
    context: RuntimeContext
  ): Promise<TResult> {
    // Resolve first: an unknown tool must not consume budget or invoke policy.
    const tool = this.toolRegistry.get(toolName);

    await this.assertToolAllowed(toolName, payload, context);

    const currentCount = this.getToolCallCount(context.taskId);
    if (this.maxToolCallsPerTask !== undefined) {
      assertMaxToolCalls(currentCount, this.maxToolCallsPerTask);
    }

    this.recordToolCall(context.taskId, currentCount + 1);

    const startedAt = Date.now();
    this.eventBus?.emit({
      name: "runtime.tool.invoked",
      payload: {
        runtimeId: context.runtimeId,
        taskId: context.taskId,
        agentId: resolveAgentId(context.agent),
        toolName,
        invokedAt: new Date().toISOString()
      }
    });

    const result = (await tool.execute({ payload, context })) as TResult;
    const durationMs = Math.max(0, Date.now() - startedAt);

    this.logger?.info("Tool invocation completed.", {
      toolName,
      durationMs
    });

    return result;
  }

  private async assertToolAllowed(
    toolName: string,
    payload: unknown,
    context: RuntimeContext
  ): Promise<void> {
    if (this.toolPolicy === undefined) {
      return;
    }

    let reason = `Tool "${toolName}" is denied by runtime policy.`;
    try {
      const decision = await this.toolPolicy.evaluate({ toolName, payload, context });

      if (decision === true) {
        return;
      }
      if (typeof decision === "object" && decision !== null) {
        if (decision.allowed === true) {
          return;
        }
        if (typeof decision.reason === "string") {
          reason = decision.reason;
        }
      }
    } catch {
      // A policy backend may throw while evaluating or while exposing a
      // decision through accessors/proxies. Fail closed without copying that
      // diagnostic into public runtime errors, audit events, or ordinary logs.
      this.denyTool(
        toolName,
        context,
        `Tool "${toolName}" denied because policy evaluation failed.`
      );
    }

    this.denyTool(toolName, context, reason);
  }

  private denyTool(
    toolName: string,
    context: RuntimeContext,
    reason: string
  ): never {
    this.eventBus?.emit({
      name: "runtime.tool.denied",
      payload: {
        runtimeId: context.runtimeId,
        taskId: context.taskId,
        agentId: resolveAgentId(context.agent),
        toolName,
        reason,
        deniedAt: new Date().toISOString()
      }
    });

    throw new RuntimeError("TOOL_POLICY_DENIED", reason, {
      toolName,
      taskId: context.taskId,
      reason
    });
  }

  private recordToolCall(taskId: string, count: number): void {
    if (!this.toolCallCounts.has(taskId)) {
      while (this.toolCallCounts.size >= this.maxTrackedTasks) {
        const oldestTaskId = this.toolCallCounts.keys().next().value as
          | string
          | undefined;
        if (oldestTaskId === undefined) {
          break;
        }
        this.toolCallCounts.delete(oldestTaskId);
      }
    }

    this.toolCallCounts.set(taskId, count);
  }
}
