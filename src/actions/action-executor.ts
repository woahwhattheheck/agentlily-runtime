import type { RuntimeEventBus } from "../events/runtime-events.js";
import { assertMaxToolCalls } from "../guards/runtime-guards.js";
import type { RuntimeLogger } from "../logger/runtime-logger.js";
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
}

export class ActionExecutor {
  private readonly toolCallCounts = new Map<string, number>();
  private readonly logger: RuntimeLogger | undefined;
  private readonly eventBus: RuntimeEventBus | undefined;
  private readonly maxToolCallsPerTask: number | undefined;
  private readonly maxTrackedTasks: number;

  public constructor(
    private readonly toolRegistry: ToolRegistry,
    maxToolCallsPerTaskOrLogger?: number | RuntimeLogger,
    eventBus?: RuntimeEventBus,
    loggerOrMaxTrackedTasks?: RuntimeLogger | number,
    maxTrackedTasks = 1_000
  ) {
    let resolvedLogger: RuntimeLogger | undefined;
    let resolvedMaxTrackedTasks = maxTrackedTasks;

    if (typeof maxToolCallsPerTaskOrLogger === "number") {
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

    this.eventBus = eventBus;
    this.logger = resolvedLogger;
    this.maxTrackedTasks = resolvedMaxTrackedTasks;
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
    // Unknown tools must not consume a task's call budget.
    const tool = this.toolRegistry.get(toolName);

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

    this.logger?.info("Tool invocation completed.", {
      toolName,
      durationMs: Math.max(0, Date.now() - startedAt)
    });

    return result;
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
