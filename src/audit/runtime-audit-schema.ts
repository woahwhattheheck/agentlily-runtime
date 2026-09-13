import { createHash } from "node:crypto";
import type {
  RuntimeEvent,
  RuntimeEventMap,
  RuntimeEventName
} from "../events/runtime-events.js";
import { RuntimeAuditLedgerError } from "./audit-errors.js";
import {
  canonicalAuditJson,
  exactAuditKeys,
  isPlainAuditRecord
} from "./canonical-json.js";

export const RUNTIME_AUDIT_VERSION = "agentlily.runtime-audit/v1" as const;
export const DEFAULT_RUNTIME_AUDIT_MAX_RECORD_BYTES = 64 * 1024;
export const RUNTIME_AUDIT_SHA256_HEX = /^[0-9a-f]{64}$/;

const RUNTIME_AUDIT_EVENT_CATALOG = {
  "runtime.internal.error": true,
  "runtime.started": true,
  "runtime.stopped": true,
  "runtime.task.received": true,
  "runtime.task.completed": true,
  "runtime.task.failed": true,
  "runtime.tool.invoked": true,
  "runtime.tool.denied": true
} satisfies Record<RuntimeEventName, true>;

export const RUNTIME_AUDIT_EVENT_NAMES = Object.keys(
  RUNTIME_AUDIT_EVENT_CATALOG
) as RuntimeEventName[];
const runtimeAuditEventNames = new Set<RuntimeEventName>(
  RUNTIME_AUDIT_EVENT_NAMES
);

export interface RuntimeAuditLedgerRecord<
  TName extends RuntimeEventName = RuntimeEventName
> {
  event: RuntimeEvent<TName>;
  previousDigest: string | null;
  recordDigest: string;
  sequence: number;
  version: typeof RUNTIME_AUDIT_VERSION;
}

export interface RuntimeAuditVerificationResult {
  ok: boolean;
  recordCount: number;
  headDigest: string | null;
  invalidRecord?: number;
  reason?: string;
}

export interface RuntimeAuditVerificationOptions {
  maxRecordBytes?: number;
}

export interface RuntimeAuditLedgerStatus {
  healthy: boolean;
  closed: boolean;
  recordCount: number;
  headDigest: string | null;
  reason?: string;
}

export interface JsonlRuntimeAuditLedgerOptions
  extends RuntimeAuditVerificationOptions {
  createParentDirectories?: boolean;
}

export function resolveRuntimeAuditMaxRecordBytes(
  value: number | undefined
): number {
  const resolved = value ?? DEFAULT_RUNTIME_AUDIT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError("maxRecordBytes must be a positive safe integer.");
  }
  return resolved;
}

export function runtimeAuditSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertRuntimeEventForAudit(
  event: unknown
): asserts event is RuntimeEvent {
  if (!isPlainAuditRecord(event) || !exactAuditKeys(event, ["name", "payload"])) {
    throw new RuntimeAuditLedgerError(
      "AUDIT_CANONICALIZATION_FAILED",
      "Audit events must contain exactly name and payload."
    );
  }
  if (
    typeof event.name !== "string" ||
    !runtimeAuditEventNames.has(event.name as RuntimeEventName)
  ) {
    throw new RuntimeAuditLedgerError(
      "AUDIT_CANONICALIZATION_FAILED",
      "Audit event name is not part of the runtime event catalog."
    );
  }
  canonicalAuditJson(event.payload);
}

export function verifyParsedRuntimeAuditRecord(
  parsed: unknown,
  expectedSequence: number,
  expectedPreviousDigest: string | null
): { digest: string } | { error: string } {
  if (!isPlainAuditRecord(parsed)) {
    return { error: "record is not a plain object" };
  }
  if (
    !exactAuditKeys(parsed, [
      "event",
      "previousDigest",
      "recordDigest",
      "sequence",
      "version"
    ])
  ) {
    return { error: "record fields are not exact" };
  }
  if (parsed.version !== RUNTIME_AUDIT_VERSION) {
    return { error: "unsupported audit version" };
  }
  if (
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence !== expectedSequence ||
    expectedSequence < 1
  ) {
    return { error: "invalid or non-monotonic sequence" };
  }
  if (parsed.previousDigest !== expectedPreviousDigest) {
    return { error: "previous digest does not match the verified chain head" };
  }
  if (
    typeof parsed.recordDigest !== "string" ||
    !RUNTIME_AUDIT_SHA256_HEX.test(parsed.recordDigest)
  ) {
    return { error: "record digest is not canonical SHA-256 hex" };
  }
  if (
    !isPlainAuditRecord(parsed.event) ||
    !exactAuditKeys(parsed.event, ["name", "payload"])
  ) {
    return { error: "event fields are not exact" };
  }
  if (
    typeof parsed.event.name !== "string" ||
    !runtimeAuditEventNames.has(parsed.event.name as RuntimeEventName)
  ) {
    return { error: "event name is not part of the current runtime event catalog" };
  }

  try {
    canonicalAuditJson(parsed.event.payload);
    const body = {
      event: parsed.event,
      previousDigest: parsed.previousDigest,
      sequence: parsed.sequence,
      version: parsed.version
    };
    const digest = runtimeAuditSha256(canonicalAuditJson(body));
    if (digest !== parsed.recordDigest) {
      return { error: "record digest mismatch" };
    }
    return { digest };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `event payload is not canonicalizable: ${error.message}`
          : "event payload is not canonicalizable"
    };
  }
}

export type { RuntimeEventMap };
