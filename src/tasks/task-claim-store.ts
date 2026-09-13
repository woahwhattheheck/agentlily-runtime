import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeError } from "../errors/runtime-errors.js";

export interface TaskClaimRecord {
  taskId: string;
  claimedAt: string;
}

/**
 * Safety authority for task IDs whose tool outcome may become ambiguous.
 *
 * `claim()` must make the claim visible before it resolves `true`. A `false`
 * result means the ID is already claimed and must not execute again.
 */
export interface TaskClaimStore {
  claim(taskId: string): Promise<boolean>;
  release(taskId: string): Promise<void>;
  has(taskId: string): Promise<boolean>;
}

export class InMemoryTaskClaimStore implements TaskClaimStore {
  private readonly claims = new Set<string>();

  public async claim(taskId: string): Promise<boolean> {
    if (this.claims.has(taskId)) {
      return false;
    }
    this.claims.add(taskId);
    return true;
  }

  public async release(taskId: string): Promise<void> {
    this.claims.delete(taskId);
  }

  public async has(taskId: string): Promise<boolean> {
    return this.claims.has(taskId);
  }
}

const fileOperationQueues = new Map<string, Promise<void>>();
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const hasErrorCode = (error: unknown, code: string): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const validateTimerOption = (
  value: number,
  name: string,
  minimum: number
): void => {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${MAX_TIMER_DELAY_MS}.`
    );
  }
};

const acquireCrossProcessLock = async (
  filePath: string,
  timeoutMs: number,
  retryDelayMs: number
): Promise<string> => {
  const resolvedPath = resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  await mkdir(dirname(resolvedPath), { recursive: true });

  const startedAt = performance.now();
  while (true) {
    try {
      // mkdir is an atomic create-if-absent primitive across Node processes on
      // the local filesystem. Only the process that creates this directory may
      // enter the JSON read/modify/write critical section.
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
          `Task claim storage at ${filePath} is locked by another process or an unreconciled prior process.`,
          {
            filePath,
            lockPath,
            timeoutMs
          }
        );
      }

      const remainingMs = timeoutMs - elapsedMs;
      await delay(Math.min(retryDelayMs, Math.max(1, remainingMs)));
    }
  }
};

const serializeFileOperation = <T>(
  filePath: string,
  lockTimeoutMs: number,
  lockRetryDelayMs: number,
  operation: () => Promise<T>
): Promise<T> => {
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
      // The durable claim JSON is the authority, not lock cleanup. If a process
      // dies while holding the lock, leaving the directory behind deliberately
      // makes future operations fail closed with STORAGE_LOCKED. If cleanup
      // itself fails after a successful durable state transition, do not turn
      // that completed transition into a misleading operation failure.
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
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
};

const isTaskClaimRecord = (value: unknown): value is TaskClaimRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.taskId === "string" &&
    candidate.taskId.length > 0 &&
    typeof candidate.claimedAt === "string"
  );
};

/**
 * File-backed task claim authority.
 *
 * Claims are intentionally not capacity-evicted: an unreleased claim is a
 * safety tombstone for an execution whose durable outcome may be unknown.
 * Operations are serialized both within this Node process and across processes
 * through an adjacent atomic lock directory.
 */
export class JsonFileTaskClaimStore implements TaskClaimStore {
  private readonly filePath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;

  public constructor(
    filePath: string,
    options: Readonly<{
      lockTimeoutMs?: number;
      lockRetryDelayMs?: number;
    }> = {}
  ) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("task claim storage path must be a non-empty string.");
    }

    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const lockRetryDelayMs =
      options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
    validateTimerOption(lockTimeoutMs, "lockTimeoutMs", 0);
    validateTimerOption(lockRetryDelayMs, "lockRetryDelayMs", 1);

    this.filePath = filePath;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryDelayMs = lockRetryDelayMs;
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async claim(taskId: string): Promise<boolean> {
    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const claims = await this.loadClaims();
        if (claims.some((claim) => claim.taskId === taskId)) {
          return false;
        }

        claims.push({ taskId, claimedAt: new Date().toISOString() });
        await this.flushAtomic(claims);
        return true;
      }
    );
  }

  public async release(taskId: string): Promise<void> {
    await serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const claims = await this.loadClaims();
        const remaining = claims.filter((claim) => claim.taskId !== taskId);
        if (remaining.length === claims.length) {
          return;
        }
        await this.flushAtomic(remaining);
      }
    );
  }

  public async has(taskId: string): Promise<boolean> {
    return serializeFileOperation(
      this.filePath,
      this.lockTimeoutMs,
      this.lockRetryDelayMs,
      async () => {
        const claims = await this.loadClaims();
        return claims.some((claim) => claim.taskId === taskId);
      }
    );
  }

  private async loadClaims(): Promise<TaskClaimRecord[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const raw = await readFile(this.filePath, "utf-8");
    if (raw.trim().length === 0) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RuntimeError(
        "STORAGE_CORRUPTED",
        `Corrupted task claim storage file at ${this.filePath}: invalid JSON.`,
        {
          filePath: this.filePath,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }

    if (!Array.isArray(parsed)) {
      throw new RuntimeError(
        "STORAGE_CORRUPTED",
        `Corrupted task claim storage file at ${this.filePath}: expected a JSON array of claims.`,
        { filePath: this.filePath }
      );
    }

    const invalidClaimIndex = parsed.findIndex(
      (claim) => !isTaskClaimRecord(claim)
    );
    if (invalidClaimIndex !== -1) {
      throw new RuntimeError(
        "STORAGE_CORRUPTED",
        `Corrupted task claim storage file at ${this.filePath}: invalid claim at index ${invalidClaimIndex}.`,
        { filePath: this.filePath, claimIndex: invalidClaimIndex }
      );
    }

    return parsed;
  }

  private async flushAtomic(claims: TaskClaimRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;

    try {
      await writeFile(tempPath, JSON.stringify(claims, null, 2), "utf-8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
