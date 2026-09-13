import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlRuntimeAuditLedger,
  attachRuntimeAuditLedger
} from "../src/audit/runtime-audit-ledger.js";
import {
  RuntimeEventBus,
  RuntimeEventListenerLimitError
} from "../src/events/runtime-events.js";

describe("attachRuntimeAuditLedger", () => {
  it("rolls back earlier registrations when attachment fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlily-audit-attach-"));
    const filePath = join(directory, "runtime-audit.jsonl");
    const eventBus = new RuntimeEventBus(1);
    const removeBlocker = eventBus.on("runtime.task.failed", () => undefined);
    const ledger = new JsonlRuntimeAuditLedger(filePath);

    try {
      expect(() => attachRuntimeAuditLedger(eventBus, ledger)).toThrow(
        RuntimeEventListenerLimitError
      );
      expect(eventBus.listenerCount()).toBe(1);
      expect(eventBus.listenerCount("runtime.started")).toBe(0);
      expect(eventBus.listenerCount("runtime.task.failed")).toBe(1);
    } finally {
      removeBlocker();
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
