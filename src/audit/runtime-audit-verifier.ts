import { existsSync, lstatSync, readFileSync } from "node:fs";
import { canonicalAuditJson } from "./canonical-json.js";
import {
  resolveRuntimeAuditMaxRecordBytes,
  verifyParsedRuntimeAuditRecord,
  type RuntimeAuditVerificationOptions,
  type RuntimeAuditVerificationResult
} from "./runtime-audit-schema.js";

export function verifyRuntimeAuditLedger(
  filePath: string,
  options: RuntimeAuditVerificationOptions = {}
): RuntimeAuditVerificationResult {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TypeError("audit ledger path must be a non-empty string.");
  }
  const maxRecordBytes = resolveRuntimeAuditMaxRecordBytes(
    options.maxRecordBytes
  );
  if (!existsSync(filePath)) {
    return { ok: true, recordCount: 0, headDigest: null };
  }

  try {
    const fileStat = lstatSync(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return {
        ok: false,
        recordCount: 0,
        headDigest: null,
        reason: "audit ledger path is not an ordinary regular file"
      };
    }
  } catch (error) {
    return {
      ok: false,
      recordCount: 0,
      headDigest: null,
      reason: error instanceof Error ? error.message : "unable to inspect ledger"
    };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      recordCount: 0,
      headDigest: null,
      reason: error instanceof Error ? error.message : "unable to read ledger"
    };
  }
  if (raw.length === 0) {
    return { ok: true, recordCount: 0, headDigest: null };
  }
  const hasTruncatedTail = !raw.endsWith("\n");
  const rawLines = raw.split("\n");
  const lines = rawLines.slice(0, -1);
  let headDigest: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      return {
        ok: false,
        recordCount: index,
        headDigest,
        invalidRecord: index + 1,
        reason: "audit ledger contains an empty record"
      };
    }
    if (Buffer.byteLength(`${line}\n`, "utf8") > maxRecordBytes) {
      return {
        ok: false,
        recordCount: index,
        headDigest,
        invalidRecord: index + 1,
        reason: `audit record exceeds ${maxRecordBytes} bytes`
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return {
        ok: false,
        recordCount: index,
        headDigest,
        invalidRecord: index + 1,
        reason: "audit record is not valid JSON"
      };
    }

    try {
      if (canonicalAuditJson(parsed) !== line) {
        return {
          ok: false,
          recordCount: index,
          headDigest,
          invalidRecord: index + 1,
          reason: "audit record is not canonical JSON"
        };
      }
    } catch (error) {
      return {
        ok: false,
        recordCount: index,
        headDigest,
        invalidRecord: index + 1,
        reason:
          error instanceof Error ? error.message : "audit record is not canonical"
      };
    }

    const checked = verifyParsedRuntimeAuditRecord(
      parsed,
      index + 1,
      headDigest
    );
    if ("error" in checked) {
      return {
        ok: false,
        recordCount: index,
        headDigest,
        invalidRecord: index + 1,
        reason: checked.error
      };
    }
    headDigest = checked.digest;
  }

  if (hasTruncatedTail) {
    return {
      ok: false,
      recordCount: lines.length,
      headDigest,
      invalidRecord: lines.length + 1,
      reason: "audit ledger has a truncated final record"
    };
  }

  return { ok: true, recordCount: lines.length, headDigest };
}
