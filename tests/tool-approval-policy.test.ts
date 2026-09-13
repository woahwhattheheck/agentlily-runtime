import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  InMemoryToolApprovalStore,
  ToolAllowlistPolicy,
  ToolApprovalPolicy,
  ToolRegistry,
  UnconfiguredModelProvider,
  digestToolApprovalPayload
} from "../src/index.js";
import type { RuntimeContext, ToolPolicy } from "../src/index.js";

const FIXED_NOW = "2026-09-13T10:00:00.000Z";

function createContext(
  taskId = "task-1",
  agentId = "agent-1"
): RuntimeContext {
  return {
    runtimeId: "approval-test-runtime",
    taskId,
    agent: new AgentInstanceManager().getOrCreate(agentId),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: FIXED_NOW
  };
}

function createStore(now: () => Date = () => new Date(FIXED_NOW)) {
  return new InMemoryToolApprovalStore({ now });
}

describe("tool approval authority", () => {
  it("produces stable, type-aware payload digests", () => {
    expect(
      digestToolApprovalPayload({
        amount: "25.00",
        nested: { z: 2, a: 1 },
        flags: [true, false]
      })
    ).toBe(
      digestToolApprovalPayload({
        flags: [true, false],
        nested: { a: 1, z: 2 },
        amount: "25.00"
      })
    );

    expect(digestToolApprovalPayload({ value: 1 })).not.toBe(
      digestToolApprovalPayload({ value: "1" })
    );
    expect(digestToolApprovalPayload({ value: 0 })).not.toBe(
      digestToolApprovalPayload({ value: -0 })
    );
    expect(digestToolApprovalPayload({ value: 1n })).not.toBe(
      digestToolApprovalPayload({ value: 1 })
    );
    expect(digestToolApprovalPayload({ value: undefined })).not.toBe(
      digestToolApprovalPayload({})
    );
  });

  it("rejects payload shapes that cannot be bound without ambiguity", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const getterPayload = {} as Record<string, unknown>;
    Object.defineProperty(getterPayload, "secret", {
      enumerable: true,
      get() {
        return "value";
      }
    });

    const symbolPayload = { visible: true } as Record<PropertyKey, unknown>;
    symbolPayload[Symbol("hidden")] = "hidden";

    const sparse = new Array(2);
    sparse[1] = "present";

    expect(() => digestToolApprovalPayload(cyclic)).toThrow(/cycles/i);
    expect(() => digestToolApprovalPayload(getterPayload)).toThrow(
      /data properties/i
    );
    expect(() => digestToolApprovalPayload(new Date())).toThrow(/plain objects/i);
    expect(() => digestToolApprovalPayload(symbolPayload)).toThrow(/symbol keys/i);
    expect(() => digestToolApprovalPayload(sparse)).toThrow(/holes/i);
    expect(() => digestToolApprovalPayload(Number.NaN)).toThrow(/finite/i);
    expect(() => digestToolApprovalPayload(Number.POSITIVE_INFINITY)).toThrow(
      /finite/i
    );
  });

  it("binds an approval to task, agent, tool, and exact payload", () => {
    const store = createStore();
    const payload = { amount: "25.00", destination: "GDEST" };

    store.approve({
      approvalId: "approval-exact",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload
    });

    expect(
      store.consume({
        taskId: "task-other",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload
      }).approved
    ).toBe(false);
    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-other",
        toolName: "wallet.execute",
        payload
      }).approved
    ).toBe(false);
    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-1",
        toolName: "wallet.sign",
        payload
      }).approved
    ).toBe(false);
    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload: { amount: "26.00", destination: "GDEST" }
      }).approved
    ).toBe(false);

    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload: { destination: "GDEST", amount: "25.00" }
      }).approved
    ).toBe(true);
  });

  it("consumes each approval once and records the consumption time", () => {
    const store = createStore();
    store.approve({
      approvalId: "approval-once",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: { amount: "1" }
    });

    const first = store.consume({
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: { amount: "1" }
    });
    expect(first).toMatchObject({ approved: true });
    expect(first.approval?.consumedAt).toBe(FIXED_NOW);
    expect(store.get("approval-once")?.consumedAt).toBe(FIXED_NOW);

    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload: { amount: "1" }
      }).approved
    ).toBe(false);
  });

  it("fails closed after expiry", () => {
    let now = new Date(FIXED_NOW);
    const store = createStore(() => now);
    store.approve({
      approvalId: "approval-expiring",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: { amount: "1" },
      expiresAt: "2026-09-13T10:01:00.000Z"
    });

    now = new Date("2026-09-13T10:01:00.000Z");
    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload: { amount: "1" }
      }).approved
    ).toBe(false);
  });

  it("requires canonical UTC expiry timestamps and future expiry", () => {
    const store = createStore();
    const request = {
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    };

    expect(() =>
      store.approve({
        ...request,
        expiresAt: "2026-09-13T10:05:00-04:00"
      })
    ).toThrow(/canonical UTC/i);
    expect(() =>
      store.approve({ ...request, expiresAt: "2026-09-13T10:00:00.000Z" })
    ).toThrow(/later/i);
  });

  it("revokes an unused approval and refuses to revoke consumed approval", () => {
    const store = createStore();
    store.approve({
      approvalId: "approval-revoke",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    });

    expect(store.revoke("approval-revoke")).toBe(true);
    expect(store.revoke("approval-revoke")).toBe(false);
    expect(store.get("approval-revoke")?.revokedAt).toBe(FIXED_NOW);

    store.approve({
      approvalId: "approval-consumed",
      taskId: "task-2",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    });
    expect(
      store.consume({
        taskId: "task-2",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload: {}
      }).approved
    ).toBe(true);
    expect(store.revoke("approval-consumed")).toBe(false);
  });

  it("refuses duplicate approval identifiers", () => {
    const store = createStore();
    const request = {
      approvalId: "duplicate",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    };

    store.approve(request);
    expect(() => store.approve(request)).toThrow(/already exists/i);
  });

  it("protects only the configured exact tool names", async () => {
    const store = createStore();
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });
    const context = createContext();

    await expect(
      policy.evaluate({ toolName: "account.read", payload: {}, context })
    ).resolves.toBe(true);
    await expect(
      policy.evaluate({ toolName: "wallet.execute", payload: {}, context })
    ).resolves.toMatchObject({ allowed: false });
    expect(policy.listProtectedTools()).toEqual(["wallet.execute"]);
  });

  it("composes with a base policy without consuming on base denial", async () => {
    const store = createStore();
    store.approve({
      approvalId: "approval-base",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: { amount: "1" }
    });
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"],
      basePolicy: new ToolAllowlistPolicy(["account.read"])
    });
    const context = createContext();

    await expect(
      policy.evaluate({
        toolName: "wallet.execute",
        payload: { amount: "1" },
        context
      })
    ).resolves.toMatchObject({ allowed: false });

    expect(
      store.consume({
        taskId: "task-1",
        agentId: "agent-1",
        toolName: "wallet.execute",
        payload: { amount: "1" }
      }).approved
    ).toBe(true);
  });

  it("requires both base-policy approval and human approval", async () => {
    const store = createStore();
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"],
      basePolicy: new ToolAllowlistPolicy(["wallet.execute"])
    });
    const context = createContext();

    await expect(
      policy.evaluate({
        toolName: "wallet.execute",
        payload: { amount: "1" },
        context
      })
    ).resolves.toMatchObject({ allowed: false });

    store.approve({
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: { amount: "1" }
    });
    await expect(
      policy.evaluate({
        toolName: "wallet.execute",
        payload: { amount: "1" },
        context
      })
    ).resolves.toEqual({ allowed: true });
  });

  it("propagates base-policy failures so the executor can fail closed", async () => {
    const store = createStore();
    const basePolicy: ToolPolicy = {
      evaluate() {
        throw new Error("private policy backend detail");
      }
    };
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"],
      basePolicy
    });

    await expect(
      policy.evaluate({
        toolName: "wallet.execute",
        payload: {},
        context: createContext()
      })
    ).rejects.toThrow("private policy backend detail");
  });

  it("integrates with ActionExecutor before budget consumption or tool effects", async () => {
    const registry = new ToolRegistry();
    let effects = 0;
    registry.register({
      name: "wallet.execute",
      description: "Sensitive test tool",
      execute() {
        effects += 1;
        return "executed";
      }
    });

    const store = createStore();
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });
    const executor = new ActionExecutor(
      registry,
      1,
      undefined,
      undefined,
      1_000,
      policy
    );
    const context = createContext();

    await expect(
      executor.execute("wallet.execute", { amount: "1" }, context)
    ).rejects.toMatchObject({ code: "TOOL_POLICY_DENIED" });
    expect(effects).toBe(0);
    expect(executor.getToolCallCount(context.taskId)).toBe(0);

    store.approve({
      taskId: context.taskId,
      agentId: context.agent.agentId ?? context.agent.id ?? "",
      toolName: "wallet.execute",
      payload: { amount: "1" }
    });
    await expect(
      executor.execute("wallet.execute", { amount: "1" }, context)
    ).resolves.toBe("executed");
    expect(effects).toBe(1);
    expect(executor.getToolCallCount(context.taskId)).toBe(1);

    await expect(
      executor.execute("wallet.execute", { amount: "1" }, context)
    ).rejects.toMatchObject({ code: "TOOL_POLICY_DENIED" });
    expect(effects).toBe(1);
    expect(executor.getToolCallCount(context.taskId)).toBe(1);
  });
});
