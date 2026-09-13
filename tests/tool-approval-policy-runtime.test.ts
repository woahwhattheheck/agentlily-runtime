import { describe, expect, it } from "vitest";
import {
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  InMemoryToolApprovalStore,
  ToolApprovalPolicy,
  UnconfiguredModelProvider
} from "../src/index.js";
import type { RuntimeContext } from "../src/index.js";

const FIXED_NOW = "2026-09-13T10:00:00.000Z";

function createContext(runtimeId: string): RuntimeContext {
  return {
    runtimeId,
    taskId: "task-1",
    agent: new AgentInstanceManager().getOrCreate("agent-1"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: FIXED_NOW
  };
}

describe("runtime-scoped tool approvals", () => {
  it("does not let an approval cross runtime boundaries or burn on mismatch", async () => {
    const store = new InMemoryToolApprovalStore({
      runtimeId: "runtime-alpha",
      now: () => new Date(FIXED_NOW)
    });
    const payload = { amount: "25.00", destination: "GDEST" };
    const approval = store.approve({
      approvalId: "runtime-bound",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload
    });
    expect(approval.runtimeId).toBe("runtime-alpha");

    const policy = new ToolApprovalPolicy({
      approvalStore: store,
      protectedTools: ["wallet.execute"]
    });

    await expect(
      policy.evaluate({
        toolName: "wallet.execute",
        payload,
        context: createContext("runtime-beta")
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("runtime-alpha")
    });
    expect(store.get("runtime-bound")?.consumedAt).toBeUndefined();

    await expect(
      policy.evaluate({
        toolName: "wallet.execute",
        payload,
        context: createContext("runtime-alpha")
      })
    ).resolves.toEqual({ allowed: true });
    expect(store.get("runtime-bound")?.consumedAt).toBe(FIXED_NOW);
  });

  it("requires an explicit non-empty runtime namespace", () => {
    expect(
      () => new InMemoryToolApprovalStore({ runtimeId: "" })
    ).toThrow(/runtimeId must be a non-empty string/i);
    expect(
      () => new InMemoryToolApprovalStore({ runtimeId: "   " })
    ).toThrow(/runtimeId must be a non-empty string/i);
  });
});
