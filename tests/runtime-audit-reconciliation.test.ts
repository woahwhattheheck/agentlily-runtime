import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlRuntimeAuditLedger,
  attachRuntimeAuditLedger,
  verifyRuntimeAuditLedger
} from "../src/audit/runtime-audit-ledger.js";
import { RuntimeEventBus } from "../src/events/runtime-events.js";

describe("runtime reconciliation audit integration", () => {
  it("persists, verifies, and continues after a reconciled task event", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlily-audit-reconcile-"));
    const filePath = join(directory, "runtime-audit.jsonl");
    const eventBus = new RuntimeEventBus();
    const first = new JsonlRuntimeAuditLedger(filePath);
    const detach = attachRuntimeAuditLedger(eventBus, first);

    try {
      const reconciled = {
        name: "runtime.task.reconciled" as const,
        payload: {
          runtimeId: "runtime-1",
          taskId: "task-1",
          claimId: "claim-generation-1",
          claimedAt: "2026-09-13T10:30:00.000Z",
          reconciledAt: "2026-09-13T10:31:00.000Z",
          authorityReference: "provider-proof-17",
          evidenceSha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          releasedForRetry: true as const
        }
      };

      eventBus.emit(reconciled);
      detach();
      first.close();

      const rawRecord = JSON.parse(readFileSync(filePath, "utf8")) as {
        event: unknown;
        sequence: number;
      };
      expect(rawRecord.sequence).toBe(1);
      expect(rawRecord.event).toEqual(reconciled);

      const beforeRestart = verifyRuntimeAuditLedger(filePath);
      expect(beforeRestart).toMatchObject({ ok: true, recordCount: 1 });
      expect(beforeRestart.headDigest).toMatch(/^[0-9a-f]{64}$/);

      const restarted = new JsonlRuntimeAuditLedger(filePath);
      restarted.append({
        name: "runtime.started",
        payload: {
          runtimeId: "runtime-2",
          occurredAt: "2026-09-13T10:32:00.000Z"
        }
      });
      restarted.close();

      expect(verifyRuntimeAuditLedger(filePath)).toMatchObject({
        ok: true,
        recordCount: 2
      });
    } finally {
      detach();
      try {
        first.close();
      } catch {
        // Test cleanup must not mask the primary assertion failure.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
