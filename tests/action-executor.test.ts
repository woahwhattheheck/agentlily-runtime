import { describe, expect, it, vi } from "vitest";
import {
  ActionExecutor,
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  RuntimeError,
  RuntimeEventBus,
  ToolRegistry,
  UnconfiguredModelProvider
} from "../src/index.js";
import type { RuntimeContext } from "../src/index.js";

describe("ActionExecutor", () => {
  const createMockContext = (taskId: string): RuntimeContext => ({
    runtimeId: "test-runtime",
    taskId,
    agent: new AgentInstanceManager().getOrCreate("test-agent"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: new Date().toISOString()
  });

  it("executes tools and tracks call counts per task", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "test-tool",
      description: "Test tool",
      execute({ payload }) {
        return { handled: payload };
      }
    });

    const executor = new ActionExecutor(registry);
    const ctx = createMockContext("task-1");

    expect(executor.getToolCallCount("task-1")).toBe(0);

    const result1 = await executor.execute("test-tool", { count: 1 }, ctx);
    expect(result1).toEqual({ handled: { count: 1 } });
    expect(executor.getToolCallCount("task-1")).toBe(1);

    const result2 = await executor.execute("test-tool", { count: 2 }, ctx);
    expect(result2).toEqual({ handled: { count: 2 } });
    expect(executor.getToolCallCount("task-1")).toBe(2);
  });

  it("does not consume a call when the tool is not registered", async () => {
    const registry = new ToolRegistry();
    const executor = new ActionExecutor(registry);
    const ctx = createMockContext("task-missing-tool");

    await expect(executor.execute("missing", {}, ctx)).rejects.toMatchObject({
      name: "RuntimeError",
      code: "TOOL_NOT_FOUND",
      details: { toolName: "missing" }
    });

    expect(executor.getToolCallCount(ctx.taskId)).toBe(0);
  });

  it("allows a valid call after an unknown tool with a one-call limit", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "Ping tool",
      execute() {
        return "pong";
      }
    });

    const executor = new ActionExecutor(registry, 1);
    const ctx = createMockContext("task-retry-after-missing-tool");

    await expect(executor.execute("missing", {}, ctx)).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND"
    });
    await expect(executor.execute("ping", {}, ctx)).resolves.toBe("pong");
    expect(executor.getToolCallCount(ctx.taskId)).toBe(1);
  });

  it("enforces maxToolCallsPerTask policy limit", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "Ping tool",
      execute() {
        return "pong";
      }
    });

    const executor = new ActionExecutor(registry, 2);
    const ctx = createMockContext("task-2");

    expect(executor.getToolCallCount("task-2")).toBe(0);

    const result1 = await executor.execute("ping", {}, ctx);
    expect(result1).toBe("pong");
    expect(executor.getToolCallCount("task-2")).toBe(1);

    const result2 = await executor.execute("ping", {}, ctx);
    expect(result2).toBe("pong");
    expect(executor.getToolCallCount("task-2")).toBe(2);

    await expect(
      executor.execute("ping", {}, ctx)
    ).rejects.toThrow("Max tool calls per task exceeded");
    expect(executor.getToolCallCount("task-2")).toBe(2);
  });

  it("fails closed instead of evicting an enforcement-bearing task budget", async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register({
      name: "ping",
      description: "Ping tool",
      execute() {
        calls++;
        return "pong";
      }
    });

    const executor = new ActionExecutor(registry, 1, undefined, 1);
    const taskA = createMockContext("task-a");
    const taskB = createMockContext("task-b");

    await expect(executor.execute("ping", {}, taskA)).resolves.toBe("pong");
    expect(executor.getToolCallCount(taskA.taskId)).toBe(1);

    // Tracking pressure from another task must not erase task A's consumed
    // quota. Reject before invoking task B rather than fail open on task A.
    await expect(executor.execute("ping", {}, taskB)).rejects.toMatchObject({
      code: "MAX_TOOL_CALLS_EXCEEDED",
      details: { taskId: "task-b", maxTrackedTasks: 1 }
    });
    expect(calls).toBe(1);
    expect(executor.getToolCallCount(taskA.taskId)).toBe(1);
    expect(executor.getToolCallCount(taskB.taskId)).toBe(0);

    await expect(executor.execute("ping", {}, taskA)).rejects.toMatchObject({
      code: "MAX_TOOL_CALLS_EXCEEDED"
    });
    expect(calls).toBe(1);

    // Completed task lifecycles explicitly release tracking capacity.
    executor.reset(taskA.taskId);
    await expect(executor.execute("ping", {}, taskB)).resolves.toBe("pong");
    expect(calls).toBe(2);
    expect(executor.getToolCallCount(taskB.taskId)).toBe(1);
  });

  it("keeps FIFO bounded tracking when no per-task quota is configured", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "Ping tool",
      execute() {
        return "pong";
      }
    });

    const executor = new ActionExecutor(registry, undefined, undefined, 1);
    const taskA = createMockContext("task-a-unbounded");
    const taskB = createMockContext("task-b-unbounded");

    await executor.execute("ping", {}, taskA);
    expect(executor.getToolCallCount(taskA.taskId)).toBe(1);

    await executor.execute("ping", {}, taskB);
    expect(executor.getToolCallCount(taskA.taskId)).toBe(0);
    expect(executor.getToolCallCount(taskB.taskId)).toBe(1);
  });

  it("rejects negative maxToolCallsPerTask limits", () => {
    const registry = new ToolRegistry();

    expect(() => new ActionExecutor(registry, -1)).toThrow(
      "maxToolCallsPerTask must be a non-negative integer."
    );
  });

  // NEW TESTS FOR THE FIX
  it("does not increment tool call count for unknown tool", async () => {
    const registry = new ToolRegistry();
    // No tools registered
    const executor = new ActionExecutor(registry);
    const ctx = createMockContext("task-3");

    const initialCount = executor.getToolCallCount("task-3");
    expect(initialCount).toBe(0);

    await expect(
      executor.execute("unknown-tool", {}, ctx)
    ).rejects.toThrow(/TOOL_NOT_FOUND/);

    // Count should remain unchanged
    expect(executor.getToolCallCount("task-3")).toBe(initialCount);
  });

  it("allows valid tool call after TOOL_NOT_FOUND when maxToolCallsPerTask is set", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "valid-tool",
      description: "Valid tool",
      execute({ payload }) {
        return { result: payload };
      }
    });

    const executor = new ActionExecutor(registry, 2); // max 2 calls
    const ctx = createMockContext("task-4");

    // First call: unknown tool -> should NOT consume budget
    await expect(
      executor.execute("unknown-tool", {}, ctx)
    ).rejects.toThrow(/TOOL_NOT_FOUND/);
    expect(executor.getToolCallCount("task-4")).toBe(0);

    // Second call: valid tool -> should succeed and increment to 1
    const result1 = await executor.execute("valid-tool", { data: "test" }, ctx);
    expect(result1).toEqual({ result: "test" });
    expect(executor.getToolCallCount("task-4")).toBe(1);

    // Third call: valid tool -> should succeed and increment to 2
    const result2 = await executor.execute("valid-tool", { data: "test2" }, ctx);
    expect(result2).toEqual({ result: "test2" });
    expect(executor.getToolCallCount("task-4")).toBe(2);

    // Fourth call: should be blocked by limit
    await expect(
      executor.execute("valid-tool", {}, ctx)
    ).rejects.toThrow(/Max tool calls per task exceeded/);
    expect(executor.getToolCallCount("task-4")).toBe(2);
  });
});
