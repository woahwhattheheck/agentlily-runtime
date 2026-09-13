import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  InMemoryToolApprovalStore,
  ToolApprovalPolicy,
  ToolRegistry,
  UnconfiguredModelProvider,
  digestToolApprovalPayload
} from "../src/index.js";
import type {
  RuntimeContext,
  ToolApprovalStore
} from "../src/index.js";

const FIXED_NOW = "2026-09-13T12:00:00.000Z";

function createContext(): RuntimeContext {
  return {
    runtimeId: "approval-binding-runtime",
    taskId: "task-1",
    agent: new AgentInstanceManager().getOrCreate("agent-1"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: FIXED_NOW
  };
}

function createExecutor(
  policy: ToolApprovalPolicy,
  execute: (payload: any) => unknown
): ActionExecutor {
  const registry = new ToolRegistry();
  registry.register({
    name: "wallet.execute",
    description: "Sensitive approval binding test tool",
    execute({ payload }) {
      return execute(payload);
    }
  });
  return new ActionExecutor(
    registry,
    1,
    undefined,
    undefined,
    1_000,
    policy
  );
}

describe("tool approval execution payload binding", () => {
  it("denies a nested mutation after approval consumption and before tool execution", async () => {
    const context = createContext();
    const payload = {
      amount: "1",
      nested: { recipient: "A" },
      rows: [{ value: 1 }]
    };
    const store = new InMemoryToolApprovalStore({
      runtimeId: context.runtimeId,
      now: () => new Date(FIXED_NOW)
    });
    store.approve({
      approvalId: "mutation-grant",
      taskId: context.taskId,
      agentId: context.agent.agentId,
      toolName: "wallet.execute",
      payload
    });
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });
    let effects = 0;
    const executor = createExecutor(policy, () => {
      effects += 1;
      return "executed";
    });

    const pending = executor.execute("wallet.execute", payload, context);
    payload.nested.recipient = "B";

    await expect(pending).rejects.toMatchObject({ code: "TOOL_POLICY_DENIED" });
    expect(effects).toBe(0);
    expect(executor.getToolCallCount(context.taskId)).toBe(0);
    expect(store.get("mutation-grant")?.consumedAt).toBe(FIXED_NOW);
  });

  it("rechecks after a deferred approval backend before returning allow", async () => {
    const context = createContext();
    const payload = { amount: "1", nested: { recipient: "A" } };
    let release: (() => void) | undefined;
    let effects = 0;
    const store: ToolApprovalStore = {
      consume(request) {
        const boundDigest = digestToolApprovalPayload(request.payload);
        return new Promise((resolve) => {
          release = () =>
            resolve({
              approved: true,
              approval: {
                approvalId: "deferred",
                runtimeId: context.runtimeId,
                taskId: context.taskId,
                agentId: context.agent.agentId,
                toolName: "wallet.execute",
                payloadDigest: boundDigest,
                grantedAt: FIXED_NOW,
                consumedAt: FIXED_NOW
              }
            });
        });
      }
    };
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });
    const executor = createExecutor(policy, () => {
      effects += 1;
      return "executed";
    });

    const pending = executor.execute("wallet.execute", payload, context);
    expect(release).toBeDefined();
    payload.nested.recipient = "B";
    release!();

    await expect(pending).rejects.toMatchObject({ code: "TOOL_POLICY_DENIED" });
    expect(effects).toBe(0);
    expect(executor.getToolCallCount(context.taskId)).toBe(0);
  });

  it("deep-freezes the exact accepted payload before the tool can observe it", async () => {
    const context = createContext();
    const payload = {
      amount: "1",
      nested: { recipient: "A" },
      rows: [{ value: 1 }]
    };
    const store = new InMemoryToolApprovalStore({
      runtimeId: context.runtimeId,
      now: () => new Date(FIXED_NOW)
    });
    store.approve({
      approvalId: "freeze-grant",
      taskId: context.taskId,
      agentId: context.agent.agentId,
      toolName: "wallet.execute",
      payload
    });
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });
    const executor = createExecutor(policy, (observed) => ({
      root: Object.isFrozen(observed),
      nested: Object.isFrozen(observed.nested),
      rows: Object.isFrozen(observed.rows),
      row: Object.isFrozen(observed.rows[0]),
      recipient: observed.nested.recipient,
      value: observed.rows[0].value
    }));

    await expect(
      executor.execute<typeof payload, Record<string, unknown>>(
        "wallet.execute",
        payload,
        context
      )
    ).resolves.toEqual({
      root: true,
      nested: true,
      rows: true,
      row: true,
      recipient: "A",
      value: 1
    });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.nested)).toBe(true);
    expect(Object.isFrozen(payload.rows)).toBe(true);
    expect(Object.isFrozen(payload.rows[0])).toBe(true);
  });

  it("rejects Proxy payloads before invoking user traps", () => {
    let trapCalls = 0;
    const target = { value: 1 };
    const payload = new Proxy(target, {
      ownKeys(current) {
        trapCalls += 1;
        return Reflect.ownKeys(current);
      },
      getPrototypeOf(current) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(current);
      },
      getOwnPropertyDescriptor(current, key) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(current, key);
      }
    });

    expect(() => digestToolApprovalPayload(payload)).toThrow(/Proxy/i);
    expect(trapCalls).toBe(0);
  });

  it("denies a store decision whose returned record binds a different payload", async () => {
    const context = createContext();
    const payload = { amount: "1" };
    const wrongDigest = digestToolApprovalPayload({ amount: "2" });
    const store: ToolApprovalStore = {
      consume() {
        return {
          approved: true,
          approval: {
            approvalId: "mismatch",
            runtimeId: context.runtimeId,
            taskId: context.taskId,
            agentId: context.agent.agentId,
            toolName: "wallet.execute",
            payloadDigest: wrongDigest,
            grantedAt: FIXED_NOW,
            consumedAt: FIXED_NOW
          }
        };
      }
    };
    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });

    await expect(
      policy.evaluate({ toolName: "wallet.execute", payload, context })
    ).resolves.toMatchObject({ allowed: false });
    expect(Object.isFrozen(payload)).toBe(false);
  });
});
