import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlRuntimeAuditLedger,
  RuntimeAuditLedgerError,
  attachRuntimeAuditLedger,
  verifyRuntimeAuditLedger
} from "../src/audit/runtime-audit-ledger.js";
import { RuntimeEventBus } from "../src/events/runtime-events.js";

function withTempLedger(
  run: (filePath: string, directory: string) => void
): void {
  const directory = mkdtempSync(join(tmpdir(), "agentlily-audit-"));
  try {
    run(join(directory, "runtime-audit.jsonl"), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedThreeRecords(filePath: string): void {
  const ledger = new JsonlRuntimeAuditLedger(filePath);
  ledger.append({
    name: "runtime.started",
    payload: { runtimeId: "runtime-1", occurredAt: "2026-09-13T09:00:00.000Z" }
  });
  ledger.append({
    name: "runtime.task.received",
    payload: { runtimeId: "runtime-1", taskId: "task-1", agentId: "agent-1" }
  });
  ledger.append({
    name: "runtime.task.completed",
    payload: {
      runtimeId: "runtime-1",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.prepare_payment",
      durationMs: 7
    }
  });
  ledger.close();
}

describe("JsonlRuntimeAuditLedger", () => {
  it("writes a verifiable hash chain and continues it across restarts", () => {
    withTempLedger((filePath) => {
      const first = new JsonlRuntimeAuditLedger(filePath);
      const firstRecord = first.append({
        name: "runtime.started",
        payload: {
          runtimeId: "runtime-1",
          occurredAt: "2026-09-13T09:00:00.000Z"
        }
      });
      const secondRecord = first.append({
        name: "runtime.task.received",
        payload: {
          runtimeId: "runtime-1",
          taskId: "task-1",
          agentId: "agent-1"
        }
      });
      first.close();

      expect(firstRecord.sequence).toBe(1);
      expect(firstRecord.previousDigest).toBeNull();
      expect(secondRecord.sequence).toBe(2);
      expect(secondRecord.previousDigest).toBe(firstRecord.recordDigest);

      const beforeRestart = verifyRuntimeAuditLedger(filePath);
      expect(beforeRestart).toEqual({
        ok: true,
        recordCount: 2,
        headDigest: secondRecord.recordDigest
      });

      const restarted = new JsonlRuntimeAuditLedger(filePath);
      const thirdRecord = restarted.append({
        name: "runtime.stopped",
        payload: {
          runtimeId: "runtime-1",
          occurredAt: "2026-09-13T09:01:00.000Z"
        }
      });
      restarted.close();

      expect(thirdRecord.sequence).toBe(3);
      expect(thirdRecord.previousDigest).toBe(secondRecord.recordDigest);
      expect(verifyRuntimeAuditLedger(filePath)).toEqual({
        ok: true,
        recordCount: 3,
        headDigest: thirdRecord.recordDigest
      });
    });
  });

  it("attaches to the runtime event bus and detaches without changing bus behavior", () => {
    withTempLedger((filePath) => {
      const eventBus = new RuntimeEventBus();
      const ledger = new JsonlRuntimeAuditLedger(filePath);
      const detach = attachRuntimeAuditLedger(eventBus, ledger);

      eventBus.emit({
        name: "runtime.started",
        payload: {
          runtimeId: "runtime-1",
          occurredAt: "2026-09-13T09:00:00.000Z"
        }
      });
      detach();
      detach();
      eventBus.emit({
        name: "runtime.stopped",
        payload: {
          runtimeId: "runtime-1",
          occurredAt: "2026-09-13T09:01:00.000Z"
        }
      });
      ledger.close();

      expect(verifyRuntimeAuditLedger(filePath).recordCount).toBe(1);
    });
  });

  it("detects one-field mutation at the exact damaged record", () => {
    withTempLedger((filePath) => {
      seedThreeRecords(filePath);
      const raw = readFileSync(filePath, "utf8");
      writeFileSync(
        filePath,
        raw.replace('"taskId":"task-1"', '"taskId":"task-X"'),
        "utf8"
      );

      expect(verifyRuntimeAuditLedger(filePath)).toMatchObject({
        ok: false,
        recordCount: 1,
        invalidRecord: 2,
        reason: "record digest mismatch"
      });
    });
  });

  const chainMutations: Array<[string, (lines: string[]) => string[]]> = [
    ["reordered", (lines) => [lines[1]!, lines[0]!, lines[2]!]],
    ["deleted", (lines) => [lines[0]!, lines[2]!]],
    ["duplicated", (lines) => [lines[0]!, lines[1]!, lines[1]!, lines[2]!]]
  ];

  for (const [label, mutate] of chainMutations) {
    it(`rejects a ${label} record chain`, () => {
      withTempLedger((filePath) => {
        seedThreeRecords(filePath);
        const lines = readFileSync(filePath, "utf8").trimEnd().split("\n");
        writeFileSync(filePath, `${mutate(lines).join("\n")}\n`, "utf8");

        expect(verifyRuntimeAuditLedger(filePath).ok).toBe(false);
      });
    });
  }

  it("preserves the verified prefix when the final record is truncated", () => {
    withTempLedger((filePath) => {
      seedThreeRecords(filePath);
      const before = verifyRuntimeAuditLedger(filePath);
      expect(before).toMatchObject({ ok: true, recordCount: 3 });
      expect(typeof before.headDigest).toBe("string");
      expect(before.headDigest?.length).toBe(64);

      const raw = readFileSync(filePath, "utf8");
      writeFileSync(filePath, `${raw}{"event":`, "utf8");

      expect(verifyRuntimeAuditLedger(filePath)).toEqual({
        ok: false,
        recordCount: 3,
        headDigest: before.headDigest,
        invalidRecord: 4,
        reason: "audit ledger has a truncated final record"
      });
      expect(() => new JsonlRuntimeAuditLedger(filePath)).toThrow(
        RuntimeAuditLedgerError
      );
    });
  });

  it("rejects noncanonical JSON even when it parses to the same object", () => {
    withTempLedger((filePath) => {
      const ledger = new JsonlRuntimeAuditLedger(filePath);
      ledger.append({
        name: "runtime.started",
        payload: {
          runtimeId: "runtime-1",
          occurredAt: "2026-09-13T09:00:00.000Z"
        }
      });
      ledger.close();

      const raw = readFileSync(filePath, "utf8");
      writeFileSync(
        filePath,
        raw.replace('"sequence":1', '"sequence":1,"sequence":1'),
        "utf8"
      );

      expect(verifyRuntimeAuditLedger(filePath)).toMatchObject({
        ok: false,
        invalidRecord: 1,
        reason: "audit record is not canonical JSON"
      });
    });
  });

  it("prevents two writers from holding the same ledger path in one process", () => {
    withTempLedger((filePath) => {
      const first = new JsonlRuntimeAuditLedger(filePath);
      expect(() => new JsonlRuntimeAuditLedger(filePath)).toThrowError(
        expect.objectContaining({ code: "AUDIT_ALREADY_OPEN" })
      );
      first.close();

      const reopened = new JsonlRuntimeAuditLedger(filePath);
      reopened.close();
    });
  });

  it("becomes sticky-unhealthy when an emitted record cannot be represented safely", () => {
    withTempLedger((filePath) => {
      const ledger = new JsonlRuntimeAuditLedger(filePath, {
        maxRecordBytes: 96
      });

      expect(() =>
        ledger.append({
          name: "runtime.task.failed",
          payload: {
            runtimeId: "runtime-1",
            taskId: "task-1",
            agentId: "agent-1",
            reason: "x".repeat(200)
          }
        })
      ).toThrowError(expect.objectContaining({ code: "AUDIT_RECORD_TOO_LARGE" }));

      expect(ledger.getStatus()).toMatchObject({ healthy: false });
      expect(() =>
        ledger.append({
          name: "runtime.started",
          payload: {
            runtimeId: "runtime-1",
            occurredAt: "2026-09-13T09:00:00.000Z"
          }
        })
      ).toThrowError(expect.objectContaining({ code: "AUDIT_UNHEALTHY" }));
      ledger.close();
    });
  });

  it("rejects accessor-backed payloads without invoking the accessor", () => {
    withTempLedger((filePath) => {
      const ledger = new JsonlRuntimeAuditLedger(filePath);
      let reads = 0;
      const payload: Record<string, unknown> = {};
      Object.defineProperty(payload, "runtimeId", {
        enumerable: true,
        get() {
          reads += 1;
          return "runtime-1";
        }
      });
      Object.defineProperty(payload, "occurredAt", {
        enumerable: true,
        value: "2026-09-13T09:00:00.000Z"
      });

      expect(() =>
        ledger.append({
          name: "runtime.started",
          payload
        } as never)
      ).toThrowError(
        expect.objectContaining({ code: "AUDIT_CANONICALIZATION_FAILED" })
      );
      expect(reads).toBe(0);
      ledger.close();
    });
  });

  it("rejects non-finite numeric payloads instead of emitting ambiguous JSON", () => {
    withTempLedger((filePath) => {
      const ledger = new JsonlRuntimeAuditLedger(filePath);
      expect(() =>
        ledger.append({
          name: "runtime.task.completed",
          payload: {
            runtimeId: "runtime-1",
            taskId: "task-1",
            agentId: "agent-1",
            toolName: "echo",
            durationMs: Number.NaN
          }
        })
      ).toThrowError(
        expect.objectContaining({ code: "AUDIT_CANONICALIZATION_FAILED" })
      );
      ledger.close();
    });
  });

  it("requires custom record-size limits consistently during verification", () => {
    withTempLedger((filePath) => {
      const ledger = new JsonlRuntimeAuditLedger(filePath, {
        maxRecordBytes: 4 * 1024
      });
      ledger.append({
        name: "runtime.task.failed",
        payload: {
          runtimeId: "runtime-1",
          taskId: "task-1",
          agentId: "agent-1",
          reason: "x".repeat(500)
        }
      });
      ledger.close();

      expect(
        verifyRuntimeAuditLedger(filePath, { maxRecordBytes: 256 })
      ).toMatchObject({ ok: false, invalidRecord: 1 });
      expect(
        verifyRuntimeAuditLedger(filePath, { maxRecordBytes: 4 * 1024 })
      ).toMatchObject({ ok: true, recordCount: 1 });
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symbolic-link ledger path",
    () => {
      withTempLedger((filePath, directory) => {
        const target = join(directory, "target.jsonl");
        writeFileSync(target, "", "utf8");
        symlinkSync(target, filePath);

        expect(verifyRuntimeAuditLedger(filePath)).toMatchObject({
          ok: false,
          reason: "audit ledger path is not an ordinary regular file"
        });
        expect(() => new JsonlRuntimeAuditLedger(filePath)).toThrow(
          RuntimeAuditLedgerError
        );
      });
    }
  );
});
