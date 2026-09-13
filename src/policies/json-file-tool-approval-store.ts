import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeError } from "../errors/runtime-errors.js";
import {
  digestToolApprovalPayload,
  type ToolApprovalConsumeDecision,
  type ToolApprovalConsumeRequest,
  type ToolApprovalGrantRequest,
  type ToolApprovalRecord,
  type ToolApprovalStore
} from "./tool-approval-policy.js";

const FILE_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const fileOperationQueues = new Map<string, Promise<void>>();

interface ApprovalFileDocument {
  version: typeof FILE_VERSION;
  approvals: ToolApprovalRecord[];
}

export interface JsonFileToolApprovalStoreOptions {
  now?: () => Date;
  lockTimeoutMs?: number;
  lockRetryDelayMs?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function requireNonEmpty(label: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseCanonicalInstant(label: string, value: string): number {
  const instant = new Date(value);
  const millis = instant.getTime();
  if (!Number.isFinite(millis) || instant.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 instant.`);
  }
  return millis;
}

function validateTimerOption(
  value: number,
  name: string,
  minimum: number
): void {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${MAX_TIMER_DELAY_MS}.`
    );
  }
}

function cloneRecord(record: ToolApprovalRecord): ToolApprovalRecord {
  return { ...record };
}

function storageCorrupted(
  filePath: string,
  message: string,
  details: Record<string, unknown> = {}
): RuntimeError {
  return new RuntimeError(
    "STORAGE_CORRUPTED",
    `Corrupted tool approval storage file at ${filePath}: ${message}`,
    { filePath, ...details }
  );
}

function readOptionalString(
  candidate: Record<string, unknown>,
  key: "expiresAt" | "consumedAt" | "revokedAt",
  filePath: string,
  recordIndex: number
): string | undefined {
  const value = candidate[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw storageCorrupted(filePath, `${key} must be a string when present.`, {
      recordIndex,
      field: key
    });
  }
  return value;
}

function validateStoredRecord(
  value: unknown,
  filePath: string,
  recordIndex: number
): ToolApprovalRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw storageCorrupted(filePath, "approval record must be an object.", {
      recordIndex
    });
  }

  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "approvalId",
    "taskId",
    "agentId",
    "toolName",
    "payloadDigest",
    "grantedAt",
    "expiresAt",
    "consumedAt",
    "revokedAt"
  ]);
  const unexpectedKey = Object.keys(candidate).find(
    (key) => !allowedKeys.has(key)
  );
  if (unexpectedKey !== undefined) {
    throw storageCorrupted(filePath, "approval record has an unknown field.", {
      recordIndex,
      field: unexpectedKey
    });
  }

  const requiredKeys = [
    "approvalId",
    "taskId",
    "agentId",
    "toolName",
    "payloadDigest",
    "grantedAt"
  ] as const;
  for (const key of requiredKeys) {
    if (typeof candidate[key] !== "string") {
      throw storageCorrupted(filePath, `${key} must be a string.`, {
        recordIndex,
        field: key
      });
    }
  }

  const approvalId = candidate.approvalId as string;
  const taskId = candidate.taskId as string;
  const agentId = candidate.agentId as string;
  const toolName = candidate.toolName as string;
  const payloadDigest = candidate.payloadDigest as string;
  const grantedAt = candidate.grantedAt as string;
  const expiresAt = readOptionalString(
    candidate,
    "expiresAt",
    filePath,
    recordIndex
  );
  const consumedAt = readOptionalString(
    candidate,
    "consumedAt",
    filePath,
    recordIndex
  );
  const revokedAt = readOptionalString(
    candidate,
    "revokedAt",
    filePath,
    recordIndex
  );

  for (const [label, fieldValue] of [
    ["approvalId", approvalId],
    ["taskId", taskId],
    ["agentId", agentId],
    ["toolName", toolName]
  ] as const) {
    if (fieldValue.trim().length === 0) {
      throw storageCorrupted(filePath, `${label} must not be empty.`, {
        recordIndex,
        field: label
      });
    }
  }

  if (!SHA256_HEX.test(payloadDigest)) {
    throw storageCorrupted(
      filePath,
      "payloadDigest must be a lowercase SHA-256 hex digest.",
      { recordIndex, field: "payloadDigest" }
    );
  }

  let grantedAtMillis: number;
  try {
    grantedAtMillis = parseCanonicalInstant("grantedAt", grantedAt);
  } catch (error) {
    throw storageCorrupted(filePath, "grantedAt is invalid.", {
      recordIndex,
      field: "grantedAt",
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  let expiresAtMillis: number | undefined;
  if (expiresAt !== undefined) {
    try {
      expiresAtMillis = parseCanonicalInstant("expiresAt", expiresAt);
    } catch (error) {
      throw storageCorrupted(filePath, "expiresAt is invalid.", {
        recordIndex,
        field: "expiresAt",
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (expiresAtMillis <= grantedAtMillis) {
      throw storageCorrupted(filePath, "expiresAt must be after grantedAt.", {
        recordIndex
      });
    }
  }

  let consumedAtMillis: number | undefined;
  if (consumedAt !== undefined) {
    try {
      consumedAtMillis = parseCanonicalInstant("consumedAt", consumedAt);
    } catch (error) {
      throw storageCorrupted(filePath, "consumedAt is invalid.", {
        recordIndex,
        field: "consumedAt",
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (consumedAtMillis < grantedAtMillis) {
      throw storageCorrupted(filePath, "consumedAt precedes grantedAt.", {
        recordIndex
      });
    }
    if (
      expiresAtMillis !== undefined &&
      consumedAtMillis >= expiresAtMillis
    ) {
      throw storageCorrupted(filePath, "consumedAt is not before expiresAt.", {
        recordIndex
      });
    }
  }

  if (revokedAt !== undefined) {
    let revokedAtMillis: number;
    try {
      revokedAtMillis = parseCanonicalInstant("revokedAt", revokedAt);
    } catch (error) {
      throw storageCorrupted(filePath, "revokedAt is invalid.", {
        recordIndex,
        field: "revokedAt",
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (revokedAtMillis < grantedAtMillis) {
      throw storageCorrupted(filePath, "revokedAt precedes grantedAt.", {
        recordIndex
      });
    }
  }

  if (consumedAt !== undefined && revokedAt !== undefined) {
    throw storageCorrupted(
      filePath,
      "approval record cannot be both consumed and revoked.",
      { recordIndex }
    );
  }

  return {
    approvalId,
    taskId,
    agentId,
    toolName,
    payloadDigest,
    grantedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt })
  };
}

async function acquireCrossProcessLock(
  filePath: string,
  timeoutMs: number,
  retryDelayMs: number
): Promise<string> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });

  const startedAt = performance.now();
  while (true) {
    try {
      await mkdir(lockPath);
      return lockPath;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw new RuntimeError(
          "STORAGE_LOCKED",
          `Tool approval storage at ${filePath} is locked by another process or an unreconciled prior process.`,
          { filePath, lockPath, timeoutMs }
        );
      }

      const remainingMs = timeoutMs - elapsedMs;
      await delay(Math.min(retryDelayMs, Math.max(1, remainingMs)));
    }
  }
}

function serializeFileOperation<T>(
  filePath: string,
  lockTimeoutMs: number,
  lockRetryDelayMs: number,
  operation: () => Promise<T>
): Promise<T> {
  const previous = fileOperationQueues.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const lockPath = await acquireCrossProcessLock(
      filePath,
      lockTimeoutMs,
      lockRetryDelayMs
    );

    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  fileOperationQueues.set(filePath, tail);

  return run.finally(() => {
    if (fileOperationQueues.get(filePath) === tail) {
      fileOperationQueues.delete(filePath);
    }
  });
}

/**
 * File-backed approval authority with restart persistence and cross-process
 * atomic compare-and-consume semantics.
 *
 * Every reader and writer sharing one file must use this lock protocol. A
 * process crash can leave the adjacent lock directory behind; that condition
 * intentionally fails closed until an operator reconciles the file and lock.
 */
export class JsonFileToolApprovalStore implements ToolApprovalStore {
  private readonly filePath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly now: () => Date;

  public constructor(
    filePath: string,
    options: JsonFileToolApprovalStoreOptions = {}
  ) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError(
        "tool approval storage path must be a non-empty string."
      );
    }

    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const lockRetryDelayMs =
      options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
    validateTimerOption(lockTimeoutMs, "lockTimeoutMs", 0);
    validateTimerOption(lockRetryDelayMs, "lockRetryDelayMs", 1);

    this.filePath = resolve(filePath);
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryDelayMs = lockRetryDelayMs;
    this.now = options.now ?? (() => new Date());
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async approve(
    request: ToolApprovalGrantRequest
  ): Promise<ToolApprovalRecord> {
    const taskId = requireNonEmpty("taskId", request.taskId);
    const agentId = requireNonEmpty("agentId", request.agentId);
    const toolName = requireNonEmpty("toolName", request.toolName);
    const approvalId =
      request.approvalId === undefined
        ? randomUUID()
        : requireNonEmpty("approvalId", request.approvalId);
    const payloadDigest = digestToolApprovalPayload(request.payload);

    return this.withRecords(async (records) => {
      if (records.some((record) => record.approvalId === approvalId)) {
        throw new RangeError(`Approval "${approvalId}" already exists.`);
      }

      const now = this.now();
      const grantedAt = now.toISOString();
      let expiresAt: string | undefined;
      if (request.expiresAt !== undefined) {
        const expiresAtMillis = parseCanonicalInstant(
          "expiresAt",
          request.expiresAt
        );
        if (expiresAtMillis <= now.getTime()) {
          throw new RangeError(
            "expiresAt must be later than the grant instant."
          );
        }
        expiresAt = request.expiresAt;
      }

      const record: ToolApprovalRecord = {
        approvalId,
        taskId,
        agentId,
        toolName,
        payloadDigest,
        grantedAt,
        ...(expiresAt === undefined ? {} : { expiresAt })
      };
      records.push(record);
      await this.flushAtomic(records);
      return cloneRecord(record);
    });
  }

  public async revoke(approvalId: string): Promise<boolean> {
    const normalizedId = requireNonEmpty("approvalId", approvalId);
    return this.withRecords(async (records) => {
      const index = records.findIndex(
        (record) => record.approvalId === normalizedId
      );
      const current = index < 0 ? undefined : records[index];
      if (
        current === undefined ||
        current.consumedAt !== undefined ||
        current.revokedAt !== undefined
      ) {
        return false;
      }

      records[index] = {
        ...current,
        revokedAt: this.now().toISOString()
      };
      await this.flushAtomic(records);
      return true;
    });
  }

  public async get(
    approvalId: string
  ): Promise<ToolApprovalRecord | undefined> {
    return this.withRecords(async (records) => {
      const record = records.find(
        (candidate) => candidate.approvalId === approvalId
      );
      return record === undefined ? undefined : cloneRecord(record);
    });
  }

  public async list(): Promise<ToolApprovalRecord[]> {
    return this.withRecords(async (records) => records.map(cloneRecord));
  }

  public async consume(
    request: ToolApprovalConsumeRequest
  ): Promise<ToolApprovalConsumeDecision> {
    let payloadDigest: string;
    try {
      payloadDigest = digestToolApprovalPayload(request.payload);
    } catch {
      return {
        approved: false,
        reason:
          "Tool payload cannot be deterministically bound to a human approval."
      };
    }

    return this.withRecords(async (records) => {
      const now = this.now();
      const nowMillis = now.getTime();
      if (!Number.isFinite(nowMillis)) {
        return {
          approved: false,
          reason:
            "Human approval authority could not establish a valid current time."
        };
      }
      const consumedAt = now.toISOString();

      const index = records.findIndex((record) => {
        if (
          record.taskId !== request.taskId ||
          record.agentId !== request.agentId ||
          record.toolName !== request.toolName ||
          record.payloadDigest !== payloadDigest ||
          record.consumedAt !== undefined ||
          record.revokedAt !== undefined
        ) {
          return false;
        }

        return (
          record.expiresAt === undefined ||
          parseCanonicalInstant("expiresAt", record.expiresAt) > nowMillis
        );
      });
      const current = index < 0 ? undefined : records[index];
      if (current === undefined) {
        return {
          approved: false,
          reason: `Tool "${request.toolName}" requires a current human approval bound to this invocation.`
        };
      }

      const consumed: ToolApprovalRecord = {
        ...current,
        consumedAt
      };
      records[index] = consumed;
      await this.flushAtomic(records);
      return { approved: true, approval: cloneRecord(consumed) };
    });
  }

  private withRecords<T>(
    operation: (records: ToolApprovalRecord[]) => Promise<T>
  ): Promise<T> {
    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => operation(await this.loadRecords())
    );
  }

  private async loadRecords(): Promise<ToolApprovalRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    if (raw.trim().length === 0) {
      throw storageCorrupted(this.filePath, "file is empty.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw storageCorrupted(this.filePath, "invalid JSON.", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw storageCorrupted(this.filePath, "expected a versioned object.");
    }

    const document = parsed as Record<string, unknown>;
    const topLevelKeys = Object.keys(document).sort();
    if (
      topLevelKeys.length !== 2 ||
      topLevelKeys[0] !== "approvals" ||
      topLevelKeys[1] !== "version" ||
      document.version !== FILE_VERSION ||
      !Array.isArray(document.approvals)
    ) {
      throw storageCorrupted(
        this.filePath,
        `expected schema { version: ${FILE_VERSION}, approvals: [] }.`
      );
    }

    const records = document.approvals.map((record, index) =>
      validateStoredRecord(record, this.filePath, index)
    );
    const seen = new Set<string>();
    const duplicateIndex = records.findIndex((record) => {
      if (seen.has(record.approvalId)) {
        return true;
      }
      seen.add(record.approvalId);
      return false;
    });
    if (duplicateIndex !== -1) {
      throw storageCorrupted(this.filePath, "duplicate approvalId found.", {
        recordIndex: duplicateIndex,
        approvalId: records[duplicateIndex]?.approvalId
      });
    }

    return records;
  }

  private async flushAtomic(records: ToolApprovalRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const document: ApprovalFileDocument = {
      version: FILE_VERSION,
      approvals: records.map(cloneRecord)
    };

    try {
      await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600
      });
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
