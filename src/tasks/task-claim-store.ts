import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const serializeFileOperation = <T>(
  filePath: string,
  operation: () => Promise<T>
): Promise<T> => {
  const key = resolve(filePath);
  const previous = fileOperationQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
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
 */
export class JsonFileTaskClaimStore implements TaskClaimStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("task claim storage path must be a non-empty string.");
    }
    this.filePath = filePath;
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async claim(taskId: string): Promise<boolean> {
    return serializeFileOperation(this.filePath, async () => {
      const claims = await this.loadClaims();
      if (claims.some((claim) => claim.taskId === taskId)) {
        return false;
      }

      claims.push({ taskId, claimedAt: new Date().toISOString() });
      await this.flushAtomic(claims);
      return true;
    });
  }

  public async release(taskId: string): Promise<void> {
    await serializeFileOperation(this.filePath, async () => {
      const claims = await this.loadClaims();
      const remaining = claims.filter((claim) => claim.taskId !== taskId);
      if (remaining.length === claims.length) {
        return;
      }
      await this.flushAtomic(remaining);
    });
  }

  public async has(taskId: string): Promise<boolean> {
    return serializeFileOperation(this.filePath, async () => {
      const claims = await this.loadClaims();
      return claims.some((claim) => claim.taskId === taskId);
    });
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
