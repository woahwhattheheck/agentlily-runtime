import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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

export interface JsonFileToolApprovalStoreOptions {
  runtimeId: string;
  now?: () => Date;
  lockTimeoutMs?: number;
  lockRetryDelayMs?: number;
}

interface DurableToolApprovalState {
  schemaVersion: 1;
  runtimeId: string;
  approvals: ToolApprovalRecord[];
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const fileOperationQueues = new Map<string, Promise<void>>();

const RECORD_REQUIRED_KEYS = [
  "approvalId",
  "runtimeId",
  "taskId",
  "agentId",
  "toolName",
  "payloadDigest",
  "grantedAt"
] as const;
const RECORD_OPTIONAL_KEYS = new Set(["expiresAt", "consumedAt", "revokedAt"]);
const STATE_KEYS = new Set(["schemaVersion", "runtimeId", "approvals"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function requireNonEmpty(label: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseCanonicalInstant(label: string, value: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 instant.`);
  }
  const instant = new Date(value);
  const millis = instant.getTime();
  if (!Number.isFinite(millis) || instant.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 instant.`);
  }
  return millis;
}

function currentInstant(now: () => Date): { instant: string; millis: number } {
  const current = now();
  const millis = current.getTime();
  if (!Number.isFinite(millis)) {
    throw new TypeError("Approval authority current time must be valid.");
  }
  return { instant: current.toISOString(), millis };
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function cloneRecord(record: ToolApprovalRecord): ToolApprovalRecord {
  return { ...record };
}

function assertExactObject(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${label} contains unknown field "${unknown}".`);
  }
}

function validateRecord(
  value: unknown,
  expectedRuntimeId: string
): ToolApprovalRecord {
  const allowed = new Set<string>([
    ...RECORD_REQUIRED_KEYS,
    ...RECORD_OPTIONAL_KEYS
  ]);
  assertExactObject(value, "approval record", allowed);

  for (const key of RECORD_REQUIRED_KEYS) {
    if (!(key in value)) {
      throw new TypeError(
        `approval record is missing required field "${key}".`
      );
    }
  }

  const approvalId = requireNonEmpty("approvalId", value.approvalId as string);
  const runtimeId = requireNonEmpty("runtimeId", value.runtimeId as string);
  const taskId = requireNonEmpty("taskId", value.taskId as string);
  const agentId = requireNonEmpty("agentId", value.agentId as string);
  const toolName = requireNonEmpty("toolName", value.toolName as string);
  const payloadDigest = value.payloadDigest;
  if (typeof payloadDigest !== "string" || !SHA256_HEX.test(payloadDigest)) {
    throw new TypeError(
      "payloadDigest must be a lowercase SHA-256 hex digest."
    );
  }
  if (runtimeId !== expectedRuntimeId) {
    throw new TypeError(
      `approval record runtimeId "${runtimeId}" does not match ` +
        `store runtimeId "${expectedRuntimeId}".`
    );
  }

  const grantedAt = value.grantedAt;
  const grantedMillis = parseCanonicalInstant("grantedAt", grantedAt as string);

  const expiresAt = value.expiresAt;
  if (expiresAt !== undefined) {
    const expiresMillis = parseCanonicalInstant(
      "expiresAt",
      expiresAt as string
    );
    if (expiresMillis <= grantedMillis) {
      throw new TypeError("expiresAt must be later than grantedAt.");
    }
  }

  const consumedAt = value.consumedAt;
  if (consumedAt !== undefined) {
    const consumedMillis = parseCanonicalInstant(
      "consumedAt",
      consumedAt as string
    );
    if (consumedMillis < grantedMillis) {
      throw new TypeError("consumedAt must not be earlier than grantedAt.");
    }
    if (
      expiresAt !== undefined &&
      consumedMillis >= parseCanonicalInstant("expiresAt", expiresAt as string)
    ) {
      throw new TypeError("consumedAt must be earlier than expiresAt.");
    }
  }

  const revokedAt = value.revokedAt;
  if (revokedAt !== undefined) {
    const revokedMillis = parseCanonicalInstant(
      "revokedAt",
      revokedAt as string
    );
    if (revokedMillis < grantedMillis) {
      throw new TypeError("revokedAt must not be earlier than grantedAt.");
    }
  }

  if (consumedAt !== undefined && revokedAt !== undefined) {
    throw new TypeError("approval record cannot be both consumed and revoked.");
  }

  return {
    approvalId,
    runtimeId,
    taskId,
    agentId,
    toolName,
    payloadDigest,
    grantedAt: grantedAt as string,
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as string }),
    ...(consumedAt === undefined ? {} : { consumedAt: consumedAt as string }),
    ...(revokedAt === undefined ? {} : { revokedAt: revokedAt as string })
  };
}

async function acquireCrossProcessLock(
  filePath: string,
  timeoutMs: number,
  retryDelayMs: number
): Promise<string> {
  const resolvedPath = resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  await mkdir(dirname(resolvedPath), { recursive: true });

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
          `Tool approval storage at ${filePath} is locked by another process ` +
            "or an unreconciled prior process.",
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
  const key = resolve(filePath);
  const previous = fileOperationQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const lockPath = await acquireCrossProcessLock(
      filePath,
      lockTimeoutMs,
      lockRetryDelayMs
    );
    try {
      return await operation();
    } finally {
      // Durable state is the authority. A crash that strands this directory is
      // intentionally fail-closed and requires operator reconciliation.
      await rm(lockPath, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  });
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  fileOperationQueues.set(key, tail);
  return run.finally(() => {
    if (fileOperationQueues.get(key) === tail) {
      fileOperationQueues.delete(key);
    }
  });
}

/**
 * Restart-durable, cross-process one-time approval authority.
 *
 * All reads that participate in mutation are performed under an adjacent
 * create-if-absent lock directory and published with atomic rename. A stranded
 * lock is not auto-broken: ambiguity about an authority-bearing transition
 * fails closed until an operator reconciles the filesystem.
 */
export class JsonFileToolApprovalStore implements ToolApprovalStore {
  private readonly filePath: string;
  private readonly runtimeId: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;

  public constructor(
    filePath: string,
    options: JsonFileToolApprovalStoreOptions
  ) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError(
        "tool approval storage path must be a non-empty string."
      );
    }
    this.runtimeId = requireNonEmpty("runtimeId", options.runtimeId);
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryDelayMs =
      options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
    validateTimerOption(this.lockTimeoutMs, "lockTimeoutMs", 0);
    validateTimerOption(this.lockRetryDelayMs, "lockRetryDelayMs", 1);
    this.filePath = filePath;
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

    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const state = await this.loadState();
        if (
          state.approvals.some(
            (approval) => approval.approvalId === approvalId
          )
        ) {
          throw new RangeError(`Approval "${approvalId}" already exists.`);
        }

        const current = currentInstant(this.now);
        let expiresAt: string | undefined;
        if (request.expiresAt !== undefined) {
          const expiresMillis = parseCanonicalInstant(
            "expiresAt",
            request.expiresAt
          );
          if (expiresMillis <= current.millis) {
            throw new RangeError(
              "expiresAt must be later than the grant instant."
            );
          }
          expiresAt = request.expiresAt;
        }

        const record: ToolApprovalRecord = {
          approvalId,
          runtimeId: this.runtimeId,
          taskId,
          agentId,
          toolName,
          payloadDigest,
          grantedAt: current.instant,
          ...(expiresAt === undefined ? {} : { expiresAt })
        };
        state.approvals.push(record);
        await this.flushAtomic(state);
        return cloneRecord(record);
      }
    );
  }

  public async revoke(approvalId: string): Promise<boolean> {
    const normalizedId = requireNonEmpty("approvalId", approvalId);
    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const state = await this.loadState();
        const index = state.approvals.findIndex(
          (record) => record.approvalId === normalizedId
        );
        if (index === -1) {
          return false;
        }
        const record = state.approvals[index]!;
        if (record.consumedAt !== undefined || record.revokedAt !== undefined) {
          return false;
        }
        const current = currentInstant(this.now);
        if (
          current.millis < parseCanonicalInstant("grantedAt", record.grantedAt)
        ) {
          throw new RangeError(
            "Current time must not precede the approval grant."
          );
        }
        state.approvals[index] = { ...record, revokedAt: current.instant };
        await this.flushAtomic(state);
        return true;
      }
    );
  }

  public async get(
    approvalId: string
  ): Promise<ToolApprovalRecord | undefined> {
    const normalizedId = requireNonEmpty("approvalId", approvalId);
    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const state = await this.loadState();
        const record = state.approvals.find(
          (approval) => approval.approvalId === normalizedId
        );
        return record === undefined ? undefined : cloneRecord(record);
      }
    );
  }

  public async consume(
    request: ToolApprovalConsumeRequest
  ): Promise<ToolApprovalConsumeDecision> {
    let runtimeId: string;
    let taskId: string;
    let agentId: string;
    let toolName: string;
    let payloadDigest: string;
    try {
      runtimeId = requireNonEmpty("runtimeId", request.runtimeId);
      taskId = requireNonEmpty("taskId", request.taskId);
      agentId = requireNonEmpty("agentId", request.agentId);
      toolName = requireNonEmpty("toolName", request.toolName);
      payloadDigest = digestToolApprovalPayload(request.payload);
    } catch {
      return {
        approved: false,
        reason:
          "Tool invocation cannot be deterministically bound to durable human approval authority."
      };
    }

    if (runtimeId !== this.runtimeId) {
      return {
        approved: false,
        reason:
          `Human approval authority is scoped to runtime "${this.runtimeId}".`
      };
    }

    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const state = await this.loadState();
        let current: { instant: string; millis: number };
        try {
          current = currentInstant(this.now);
        } catch {
          return {
            approved: false,
            reason:
              "Human approval authority could not establish a valid current time."
          };
        }
        for (let index = 0; index < state.approvals.length; index++) {
          const record = state.approvals[index]!;
          if (
            record.runtimeId !== runtimeId ||
            record.taskId !== taskId ||
            record.agentId !== agentId ||
            record.toolName !== toolName ||
            record.payloadDigest !== payloadDigest ||
            record.consumedAt !== undefined ||
            record.revokedAt !== undefined
          ) {
            continue;
          }

          const grantedMillis = parseCanonicalInstant(
            "grantedAt",
            record.grantedAt
          );
          if (current.millis < grantedMillis) {
            continue;
          }
          if (
            record.expiresAt !== undefined &&
            parseCanonicalInstant("expiresAt", record.expiresAt) <=
              current.millis
          ) {
            continue;
          }

          const consumed: ToolApprovalRecord = {
            ...record,
            consumedAt: current.instant
          };
          state.approvals[index] = consumed;
          await this.flushAtomic(state);
          return { approved: true, approval: cloneRecord(consumed) };
        }

        return {
          approved: false,
          reason:
            `Tool "${toolName}" requires a current human approval bound ` +
            "to this invocation."
        };
      }
    );
  }

  private emptyState(): DurableToolApprovalState {
    return {
      schemaVersion: 1,
      runtimeId: this.runtimeId,
      approvals: []
    };
  }

  private async loadState(): Promise<DurableToolApprovalState> {
    if (!existsSync(this.filePath)) {
      return this.emptyState();
    }

    const raw = await readFile(this.filePath, "utf8");
    if (raw.trim().length === 0) {
      throw this.corrupted("storage file is empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw this.corrupted("storage file is not valid JSON");
    }

    try {
      assertExactObject(parsed, "tool approval storage", STATE_KEYS);
      if (parsed.schemaVersion !== 1) {
        throw new TypeError("schemaVersion must equal 1.");
      }
      if (parsed.runtimeId !== this.runtimeId) {
        throw new TypeError(
          `stored runtimeId must equal "${this.runtimeId}".`
        );
      }
      if (!Array.isArray(parsed.approvals)) {
        throw new TypeError("approvals must be an array.");
      }

      const approvals = parsed.approvals.map((record) =>
        validateRecord(record, this.runtimeId)
      );
      const ids = new Set<string>();
      for (const record of approvals) {
        if (ids.has(record.approvalId)) {
          throw new TypeError(
            `duplicate approvalId "${record.approvalId}" in durable state.`
          );
        }
        ids.add(record.approvalId);
      }

      return { schemaVersion: 1, runtimeId: this.runtimeId, approvals };
    } catch (error) {
      throw this.corrupted(
        error instanceof Error
          ? error.message
          : "invalid durable approval state"
      );
    }
  }

  private corrupted(reason: string): RuntimeError {
    return new RuntimeError(
      "STORAGE_CORRUPTED",
      `Corrupted tool approval storage file at ${this.filePath}: ${reason}.`,
      { filePath: this.filePath }
    );
  }

  private async flushAtomic(state: DurableToolApprovalState): Promise<void> {
    const dir = dirname(this.filePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
