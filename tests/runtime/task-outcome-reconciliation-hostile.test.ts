import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  InMemoryTaskClaimStore,
  type TaskOutcomeReconciliationAuthority
} from "../../src/index.js";

const SHA256 = "b".repeat(64);

const hostileAuthority = (
  decision: unknown
): TaskOutcomeReconciliationAuthority =>
  ({
    async verifyNotApplied() {
      return decision;
    }
  }) as unknown as TaskOutcomeReconciliationAuthority;

describe("hostile reconciliation authority output", () => {
  it.each([
    ["null", null],
    ["array", []],
    ["missing proof", { confirmedNotApplied: true }],
    [
      "uppercase digest",
      {
        confirmedNotApplied: true,
        confirmedQuiescent: true,
        authorityReference: "provider:terminal",
        evidenceSha256: SHA256.toUpperCase()
      }
    ],
    [
      "control-character reference",
      {
        confirmedNotApplied: true,
        confirmedQuiescent: true,
        authorityReference: "provider:terminal\nspoofed-log-line",
        evidenceSha256: SHA256
      }
    ]
  ])("fails closed on %s", async (_name, decision) => {
    const claims = new InMemoryTaskClaimStore();
    expect(await claims.claim("hostile-task")).toBe(true);

    const runtime = new AgentRuntime({
      runtimeId: "hostile-reconciliation-runtime",
      taskClaimStore: claims,
      taskOutcomeReconciliationAuthority: hostileAuthority(decision)
    });
    await runtime.start();

    await expect(
      runtime.reconcileUnknownOutcome("hostile-task", { secret: "opaque" })
    ).rejects.toMatchObject({
      code: "TASK_RECONCILIATION_REJECTED"
    });
    expect(await claims.has("hostile-task")).toBe(true);

    await runtime.stop();
  });
});
