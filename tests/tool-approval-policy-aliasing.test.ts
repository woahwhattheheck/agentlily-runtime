import { describe, expect, it } from "vitest";
import {
  InMemoryToolApprovalStore,
  digestToolApprovalPayload
} from "../src/index.js";

describe("tool approval payload aliasing", () => {
  it("rejects acyclic shared references instead of collapsing alias identity", () => {
    const shared = { value: "same object" };
    const aliased = { left: shared, right: shared };
    const copied = {
      left: { value: "same object" },
      right: { value: "same object" }
    };

    expect(() => digestToolApprovalPayload(aliased)).toThrow(
      /shared references/i
    );
    expect(() => digestToolApprovalPayload(copied)).not.toThrow();
  });

  it("fails closed when the approval authority cannot establish current time", () => {
    let now = new Date("2026-09-13T10:00:00.000Z");
    const store = new InMemoryToolApprovalStore({
      runtimeId: "approval-test-runtime",
      now: () => now
    });
    const payload = { amount: "1" };

    store.approve({
      approvalId: "clock-fence",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload
    });

    now = new Date(Number.NaN);
    const decision = store.consume({
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload
    });

    expect(decision).toMatchObject({
      approved: false,
      reason: expect.stringMatching(/valid current time/i)
    });
    expect(store.get("clock-fence")?.consumedAt).toBeUndefined();
  });
});
