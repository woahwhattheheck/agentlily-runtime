import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  RuntimeEvent,
  RuntimeEventBus,
  RuntimeEventName
} from "../events/runtime-events.js";
import { RuntimeAuditLedgerError } from "./audit-errors.js";
import { canonicalAuditJson } from "./canonical-json.js";
import {
  RUNTIME_AUDIT_EVENT_NAMES,
  RUNTIME_AUDIT_VERSION,
  assertRuntimeEventForAudit,
  resolveRuntimeAuditMaxRecordBytes,
  runtimeAuditSha256,
  type JsonlRuntimeAuditLedgerOptions,
  type RuntimeAuditLedgerRecord,
  type RuntimeAuditLedgerStatus
} from "./runtime-audit-schema.js";
import { verifyRuntimeAuditLedger } from "./runtime-audit-verifier.js";

const activeLedgerPaths = new Set<string>();

export class JsonlRuntimeAuditLedger {
  private readonly filePath: string;
  private readonly maxRecordBytes: number;
  private fileDescriptor: number | null = null;
  private recordCount = 0;
  private headDigest: string | null = null;
  private healthy = true;
  private healthReason: string | undefined;
  private closed = false;

  public constructor(
    filePath: string,
    options: JsonlRuntimeAuditLedgerOptions = {}
  ) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("audit ledger path must be a non-empty string.");
    }
    this.filePath = resolve(filePath);
    this.maxRecordBytes = resolveRuntimeAuditMaxRecordBytes(
      options.maxRecordBytes
    );
    if (activeLedgerPaths.has(this.filePath)) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_ALREADY_OPEN",
        "An audit ledger writer is already open for this path in this process."
      );
    }
    activeLedgerPaths.add(this.filePath);

    try {
      const verification = verifyRuntimeAuditLedger(this.filePath, {
        maxRecordBytes: this.maxRecordBytes
      });
      if (!verification.ok) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_CORRUPTED",
          `Refusing to append to an invalid audit ledger${
            verification.reason ? `: ${verification.reason}` : "."
          }`
        );
      }

      if (options.createParentDirectories === true) {
        mkdirSync(dirname(this.filePath), { recursive: true });
      }
      if (existsSync(this.filePath)) {
        const stat = lstatSync(this.filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new RuntimeAuditLedgerError(
            "AUDIT_NON_REGULAR_FILE",
            "Audit ledger path must be an ordinary regular file."
          );
        }
      }

      this.fileDescriptor = openSync(this.filePath, "a", 0o600);
      if (!fstatSync(this.fileDescriptor).isFile()) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_NON_REGULAR_FILE",
          "Audit ledger descriptor is not a regular file."
        );
      }

      const afterOpen = verifyRuntimeAuditLedger(this.filePath, {
        maxRecordBytes: this.maxRecordBytes
      });
      if (!afterOpen.ok) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_CORRUPTED",
          `Audit ledger changed or became invalid while opening${
            afterOpen.reason ? `: ${afterOpen.reason}` : "."
          }`
        );
      }
      this.recordCount = afterOpen.recordCount;
      this.headDigest = afterOpen.headDigest;
    } catch (error) {
      if (this.fileDescriptor !== null) {
        closeSync(this.fileDescriptor);
        this.fileDescriptor = null;
      }
      activeLedgerPaths.delete(this.filePath);
      throw error;
    }
  }

  public append<TName extends RuntimeEventName>(
    event: RuntimeEvent<TName>
  ): RuntimeAuditLedgerRecord<TName> {
    this.assertHealthy();
    if (this.closed || this.fileDescriptor === null) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_UNHEALTHY",
        "Audit ledger is closed."
      );
    }

    try {
      assertRuntimeEventForAudit(event);
      const body = {
        event,
        previousDigest: this.headDigest,
        sequence: this.recordCount + 1,
        version: RUNTIME_AUDIT_VERSION
      };
      const recordDigest = runtimeAuditSha256(canonicalAuditJson(body));
      const record: RuntimeAuditLedgerRecord<TName> = {
        ...body,
        recordDigest
      };
      const line = `${canonicalAuditJson(record)}\n`;
      const byteLength = Buffer.byteLength(line, "utf8");
      if (byteLength > this.maxRecordBytes) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_RECORD_TOO_LARGE",
          `Audit record exceeds ${this.maxRecordBytes} bytes.`
        );
      }

      const written = writeSync(this.fileDescriptor, line, null, "utf8");
      if (written !== byteLength) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_IO_FAILED",
          "Audit ledger write was incomplete."
        );
      }
      fsyncSync(this.fileDescriptor);
      this.recordCount = record.sequence;
      this.headDigest = recordDigest;
      return record;
    } catch (error) {
      this.markUnhealthy(error);
      throw error;
    }
  }

  public getStatus(): RuntimeAuditLedgerStatus {
    const status: RuntimeAuditLedgerStatus = {
      healthy: this.healthy,
      closed: this.closed,
      recordCount: this.recordCount,
      headDigest: this.headDigest
    };
    if (this.healthReason !== undefined) {
      status.reason = this.healthReason;
    }
    return status;
  }

  public assertHealthy(): void {
    if (!this.healthy) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_UNHEALTHY",
        this.healthReason ?? "Audit ledger is unhealthy."
      );
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    let failure: unknown;
    if (this.fileDescriptor !== null) {
      try {
        fsyncSync(this.fileDescriptor);
      } catch (error) {
        failure = error;
      }
      try {
        closeSync(this.fileDescriptor);
      } catch (error) {
        failure ??= error;
      }
      this.fileDescriptor = null;
    }
    activeLedgerPaths.delete(this.filePath);

    if (failure !== undefined) {
      this.markUnhealthy(failure);
      throw failure;
    }
  }

  private markUnhealthy(error: unknown): void {
    this.healthy = false;
    this.healthReason =
      error instanceof Error ? error.message : "Unknown audit ledger failure.";
  }
}

export function attachRuntimeAuditLedger(
  eventBus: RuntimeEventBus,
  ledger: JsonlRuntimeAuditLedger
): () => void {
  const detachCallbacks = RUNTIME_AUDIT_EVENT_NAMES.map((eventName) =>
    eventBus.on(eventName, (event) => {
      ledger.append(event);
    })
  );

  let detached = false;
  return () => {
    if (detached) {
      return;
    }
    detached = true;
    for (const detach of detachCallbacks) {
      detach();
    }
  };
}

export { RuntimeAuditLedgerError, verifyRuntimeAuditLedger };
export type { RuntimeAuditLedgerErrorCode } from "./audit-errors.js";
export type {
  JsonlRuntimeAuditLedgerOptions,
  RuntimeAuditLedgerRecord,
  RuntimeAuditLedgerStatus,
  RuntimeAuditVerificationOptions,
  RuntimeAuditVerificationResult
} from "./runtime-audit-schema.js";
