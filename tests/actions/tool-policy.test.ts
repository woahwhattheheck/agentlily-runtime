import { describe, expect, it, vi } from "vitest";
import {
  ActionExecutor,
  AgentInstanceManager,
  createRuntimeDependencies,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  RuntimeEventBus,
  ToolAllowlistPolicy,
  ToolRegistry,
  UnconfiguredModelProvider
} from "../../src/index.js";
import type {
  RuntimeContext,
  ToolPolicy,
  ToolPolicyRequest
} from "../../src/index.js";

function createMockContext(taskId: string): RuntimeContext {
  return {
    runtimeId: "policy-runtime",
    taskId,
    agent: new AgentInstanceManager().getOrCreate("policy-agent"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: new Date().toISOString()
  };
}

function createExecutor(
  registry: ToolRegistry,
  policy: ToolPolicy,
  eventBus?: RuntimeEventBus,
  maxToolCallsPerTask?: number
): ActionExecutor {
  return new ActionExecutor(
    registry,
    maxToolCallsPerTask,
    eventBus,
    undefined,
    undefined,
    policy
  );
}

describe("runtime tool policies", () => {
  it("allows exact names in ToolAllowlistPolicy", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(({ payload }: { payload: unknown }) => ({ payload }));
    registry.register({
      name: "read",
      description: "Read-only test tool",
      execute
    });

    const policy = new ToolAllowlistPolicy(["read"]);
    const executor = createExecutor(registry, policy);
    const result = await executor.execute(
      "read",
      { value: 42 },
      createMockContext("allow-task")
    );

    expect(result).toEqual({ payload: { value: 42 } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executor.getToolCallCount("allow-task")).toBe(1);
    expect(policy.listAllowedTools()).toEqual(["read"]);
  });

  it("denies unlisted tools before invocation or quota accounting", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(() => ({ changed: true }));
    registry.register({
      name: "write",
      description: "Mutation test tool",
      execute
    });

    const eventBus = new RuntimeEventBus();
    const invoked = vi.fn();
    const denied = vi.fn();
    eventBus.on("runtime.tool.invoked", invoked);
    eventBus.on("runtime.tool.denied", denied);

    const executor = createExecutor(
      registry,
      new ToolAllowlistPolicy(["read"]),
      eventBus,
      1
    );
    const context = createMockContext("deny-task");

    await expect(
      executor.execute("write", { value: 1 }, context)
    ).rejects.toMatchObject({
      name: "RuntimeError",
      code: "TOOL_POLICY_DENIED",
      details: {
        toolName: "write",
        taskId: "deny-task"
      }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
    expect(executor.getToolCallCount("deny-task")).toBe(0);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0]![0]).toMatchObject({
      name: "runtime.tool.denied",
      payload: {
        runtimeId: "policy-runtime",
        taskId: "deny-task",
        toolName: "write",
        reason: 'Tool "write" is not in the runtime allowlist.'
      }
    });
    expect(
      (denied.mock.calls[0]![0] as { payload: { deniedAt: string } }).payload
        .deniedAt
    ).toEqual(expect.any(String));
  });

  it("passes payload and task context to async custom policies", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "conditional",
      description: "Conditionally authorized tool",
      execute: () => "ok"
    });

    const evaluate = vi.fn(async (request: ToolPolicyRequest) => ({
      allowed:
        request.toolName === "conditional" &&
        request.context.taskId === "approved-task" &&
        (request.payload as { approved?: boolean }).approved === true
    }));
    const policy: ToolPolicy = { evaluate };
    const executor = createExecutor(registry, policy);
    const context = createMockContext("approved-task");

    await expect(
      executor.execute("conditional", { approved: true }, context)
    ).resolves.toBe("ok");

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]![0]).toMatchObject({
      toolName: "conditional",
      payload: { approved: true },
      context: { taskId: "approved-task" }
    });
  });

  it("fails closed when a policy evaluator throws", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(() => "unsafe");
    registry.register({
      name: "unstable",
      description: "Tool behind a failing policy",
      execute
    });

    const eventBus = new RuntimeEventBus();
    const denied = vi.fn();
    eventBus.on("runtime.tool.denied", denied);

    const policy: ToolPolicy = {
      evaluate: async () => {
        throw new Error("policy backend unavailable");
      }
    };
    const executor = createExecutor(registry, policy, eventBus);

    await expect(
      executor.execute("unstable", {}, createMockContext("fail-closed-task"))
    ).rejects.toMatchObject({
      name: "RuntimeError",
      code: "TOOL_POLICY_DENIED",
      details: {
        toolName: "unstable",
        taskId: "fail-closed-task",
        cause: "policy backend unavailable"
      }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(executor.getToolCallCount("fail-closed-task")).toBe(0);
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("keeps TOOL_NOT_FOUND precedence and does not evaluate policy", async () => {
    const registry = new ToolRegistry();
    const evaluate = vi.fn(() => true);
    const executor = createExecutor(registry, { evaluate });

    await expect(
      executor.execute("missing", {}, createMockContext("missing-task"))
    ).rejects.toMatchObject({
      name: "RuntimeError",
      code: "TOOL_NOT_FOUND"
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(executor.getToolCallCount("missing-task")).toBe(0);
  });

  it("preserves allow-all behavior when no policy is configured", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "legacy",
      description: "Legacy unrestricted tool",
      execute: () => "legacy-ok"
    });

    const executor = new ActionExecutor(registry);
    await expect(
      executor.execute("legacy", {}, createMockContext("legacy-task"))
    ).resolves.toBe("legacy-ok");
  });

  it("wires RuntimeOptions.toolPolicy through createRuntimeDependencies", async () => {
    const execute = vi.fn(() => "should-not-run");
    const dependencies = createRuntimeDependencies({
      runtimeId: "bootstrap-policy-runtime",
      tools: [
        {
          name: "blocked",
          description: "Blocked through RuntimeOptions",
          execute
        }
      ],
      toolPolicy: new ToolAllowlistPolicy([])
    });
    const context: RuntimeContext = {
      runtimeId: "bootstrap-policy-runtime",
      taskId: "bootstrap-policy-task",
      agent: dependencies.agentManager.getOrCreate("policy-agent"),
      memory: dependencies.memoryStore,
      modelProvider: dependencies.modelProvider,
      state: dependencies.stateStore,
      now: new Date().toISOString()
    };

    await expect(
      dependencies.actionExecutor.execute("blocked", {}, context)
    ).rejects.toMatchObject({ code: "TOOL_POLICY_DENIED" });
    expect(execute).not.toHaveBeenCalled();
  });
});
