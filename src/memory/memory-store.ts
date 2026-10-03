import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeError } from "../errors/runtime-errors.js";

export interface MemoryEntry {
  agentId: string;
  taskId: string;
  input: string;
  output: unknown;
  recordedAt: string;
}

export interface ListMemoryOptions {
  /** Maximum number of matching entries to return. Must be a non-negative integer. */
  limit?: number;
  /** Number of matching entries to skip. Must be a non-negative integer. */
  offset?: number;
}

export interface InMemoryMemoryStoreOptions {
  /**
   * Maximum total entries retained across all agents before FIFO eviction.
   * Default: 10,000.
   */
  maxEntries?: number;
  /**
   * Maximum entries retained per individual agent before FIFO eviction.
   * Default: 1,000. Set to 0 for unbounded per-agent growth.
   */
  maxEntriesPerAgent?: number;
}

export interface MemoryStore {
  append(entry: MemoryEntry): Promise<void>;
  listByAgent(
    agentId: string,
    options?: ListMemoryOptions
  ): Promise<MemoryEntry[]>;
  countByAgent?(agentId: string): Promise<number>;
  clear?(): Promise<void>;
}

export const DEFAULT_MAX_MEMORY_ENTRIES = 10_000;
export const DEFAULT_MAX_MEMORY_ENTRIES_PER_AGENT = 1_000;

function assertListMemoryOptions(options?: ListMemoryOptions): void {
  if (
    options?.offset !== undefined &&
    (!Number.isInteger(options.offset) || options.offset < 0)
  ) {
    throw new RangeError("offset must be a non-negative integer.");
  }
  if (
    options?.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 0)
  ) {
    throw new RangeError("limit must be a non-negative integer.");
  }
}

const cloneOutput = (val: unknown): unknown => {
  if (val === null || (typeof val !== "object" && typeof val !== "function")) {
    return val;
  }
  try {
    return structuredClone(val);
  } catch {
    try {
      return JSON.parse(JSON.stringify(val));
    } catch {
      throw new TypeError("Memory output must be defensively cloneable.");
    }
  }
};

const selectMemoryEntries = (
  entries: readonly MemoryEntry[],
  agentId: string,
  options?: ListMemoryOptions
): MemoryEntry[] => {
  let remainingOffset = options?.offset ?? 0;
  const limit = options?.limit ?? Number.POSITIVE_INFINITY;
  const selected: MemoryEntry[] = [];
  if (limit === 0) {
    return selected;
  }

  for (const entry of entries) {
    if (entry.agentId !== agentId) {
      continue;
    }
    if (remainingOffset > 0) {
      remainingOffset--;
      continue;
    }
    selected.push({
      ...entry,
      output: cloneOutput(entry.output)
    });
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
};

const isPersistedMemoryEntry = (
  value: unknown
): value is Record<string, unknown> & MemoryEntry => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.agentId === "string" &&
    typeof candidate.taskId === "string" &&
    typeof candidate.input === "string" &&
    typeof candidate.recordedAt === "string"
  );
};

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries: MemoryEntry[] = [];

  public readonly maxEntries: number;
  public readonly maxEntriesPerAgent: number;

  public constructor(options: InMemoryMemoryStoreOptions | number = {}) {
    const resolved =
      typeof options === "number" ? { maxEntries: options } : options;
    const maxEntries = resolved.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
    const maxEntriesPerAgent =
      resolved.maxEntriesPerAgent ?? DEFAULT_MAX_MEMORY_ENTRIES_PER_AGENT;

    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer.");
    }
    if (!Number.isInteger(maxEntriesPerAgent) || maxEntriesPerAgent < 0) {
      throw new RangeError(
        "maxEntriesPerAgent must be a non-negative integer."
      );
    }

    this.maxEntries = maxEntries;
    this.maxEntriesPerAgent = maxEntriesPerAgent;
  }

  public get capacity(): number {
    return this.maxEntries;
  }

  public get size(): number {
    return this.entries.length;
  }

  public async append(entry: MemoryEntry): Promise<void> {
    // Clone entry defensively so external mutation cannot corrupt store state.
    const entryCopy: MemoryEntry = {
      agentId: entry.agentId,
      taskId: entry.taskId,
      input: entry.input,
      output: cloneOutput(entry.output),
      recordedAt: entry.recordedAt
    };

    // Enforce the per-agent limit by evicting that agent's oldest entry.
    if (this.maxEntriesPerAgent > 0) {
      let agentCount = 0;
      let oldestAgentIndex = -1;

      for (let i = 0; i < this.entries.length; i++) {
        if (this.entries[i]?.agentId === entryCopy.agentId) {
          if (oldestAgentIndex === -1) {
            oldestAgentIndex = i;
          }
          agentCount++;
        }
      }

      if (agentCount >= this.maxEntriesPerAgent && oldestAgentIndex !== -1) {
        this.entries.splice(oldestAgentIndex, 1);
      }
    }

    // Enforce the global capacity limit by evicting the oldest entry (FIFO).
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }

    this.entries.push(entryCopy);
  }

  public async listByAgent(
    agentId: string,
    options?: ListMemoryOptions
  ): Promise<MemoryEntry[]> {
    assertListMemoryOptions(options);

    return selectMemoryEntries(this.entries, agentId, options);
  }

  public async countByAgent(agentId: string): Promise<number> {
    let count = 0;
    for (const entry of this.entries) {
      if (entry.agentId === agentId) {
        count++;
      }
    }
    return count;
  }

  public async clear(): Promise<void> {
    this.entries.length = 0;
  }
}

export interface JsonFileMemoryStoreOptions {
  /**
   * Maximum total entries retained across all agents before FIFO eviction.
   * Default: 10,000.
   */
  maxEntries?: number;
  /**
   * Maximum entries retained per individual agent before FIFO eviction.
   * Default: unbounded. Set to 0 for unbounded per-agent growth.
   */
  maxEntriesPerAgent?: number;
  /** Maximum wait for another process's writer lock. Default: 5,000 ms. */
  lockTimeoutMs?: number;
  /** Delay between writer-lock attempts. Default: 10 ms. */
  lockRetryDelayMs?: number;
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

export class JsonFileMemoryStore implements MemoryStore {
  private readonly filePath: string;
  private readonly storagePath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;

  public readonly maxEntries: number;
  public readonly maxEntriesPerAgent: number;

  public constructor(filePath: string, options: JsonFileMemoryStoreOptions = {}) {
    this.filePath = filePath;
    this.storagePath = resolve(filePath);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? 10;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
    this.maxEntriesPerAgent = options.maxEntriesPerAgent ?? 0;

    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer.");
    }
    if (
      !Number.isInteger(this.maxEntriesPerAgent) ||
      this.maxEntriesPerAgent < 0
    ) {
      throw new RangeError("maxEntriesPerAgent must be a non-negative integer.");
    }
    for (const [name, value, minimum] of [
      ["lockTimeoutMs", this.lockTimeoutMs, 0],
      ["lockRetryDelayMs", this.lockRetryDelayMs, 1]
    ] as const) {
      if (!Number.isInteger(value) || value < minimum || value > 2_147_483_647) {
        throw new RangeError(
          `${name} must be an integer between ${minimum} and 2147483647.`
        );
      }
    }
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public get capacity(): number {
    return this.maxEntries;
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    return serializeFileOperation(this.storagePath, async () => {
      const lockPath = `${this.storagePath}.lock`;
      await mkdir(dirname(this.storagePath), { recursive: true });
      const startedAt = performance.now();
      while (true) {
        try {
          // One atomic create protects the complete read/modify/rename cycle.
          await mkdir(lockPath);
          break;
        } catch (error) {
          if (
            error === null ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "EEXIST"
          ) {
            throw error;
          }
          const remainingMs = this.lockTimeoutMs - (performance.now() - startedAt);
          if (remainingMs <= 0) {
            throw new RuntimeError(
              "STORAGE_LOCKED",
              `Memory storage at ${this.filePath} is locked by another process or an unreconciled prior process.`,
              { filePath: this.filePath, lockPath, timeoutMs: this.lockTimeoutMs }
            );
          }
          await delay(Math.min(this.lockRetryDelayMs, Math.max(1, remainingMs)));
        }
      }
      try {
        return await operation();
      } finally {
        // Never reclaim another process's lock automatically. A crash leaves
        // it for operator reconciliation. Cleanup failure after rename must
        // not misreport a committed append as a failed operation.
        await rmdir(lockPath).catch(() => undefined);
      }
    });
  }

  private async loadEntries(): Promise<MemoryEntry[]> {
    if (!existsSync(this.storagePath)) {
      return [];
    }

    const raw = await readFile(this.storagePath, "utf-8");
    if (raw.trim().length === 0) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RuntimeError(
        "STORAGE_CORRUPTED",
        `Corrupted memory storage file at ${this.filePath}: invalid JSON.`,
        {
          filePath: this.filePath,
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }

    if (!Array.isArray(parsed)) {
      throw new RuntimeError(
        "STORAGE_CORRUPTED",
        `Corrupted memory storage file at ${this.filePath}: expected a JSON array of entries.`,
        {
          filePath: this.filePath,
          receivedType: typeof parsed
        }
      );
    }

    const invalidEntryIndex = parsed.findIndex(
      (entry) => !isPersistedMemoryEntry(entry)
    );
    if (invalidEntryIndex !== -1) {
      throw new RuntimeError(
        "STORAGE_CORRUPTED",
        `Corrupted memory storage file at ${this.filePath}: invalid memory entry at index ${invalidEntryIndex}.`,
        {
          filePath: this.filePath,
          entryIndex: invalidEntryIndex
        }
      );
    }

    return parsed;
  }

  private async flushAtomic(entries: MemoryEntry[]): Promise<void> {
    const dir = dirname(this.storagePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    const data = JSON.stringify(entries, null, 2);

    try {
      await writeFile(tempPath, data, "utf-8");
      await rename(tempPath, this.storagePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async size(): Promise<number> {
    return serializeFileOperation(this.storagePath, async () => {
      const entries = await this.loadEntries();
      return entries.length;
    });
  }

  public async append(entry: MemoryEntry): Promise<void> {
    const entryCopy: MemoryEntry = {
      agentId: entry.agentId,
      taskId: entry.taskId,
      input: entry.input,
      output: cloneOutput(entry.output),
      recordedAt: entry.recordedAt
    };

    await this.serializeWrite(async () => {
      const entries = await this.loadEntries();

      if (this.maxEntriesPerAgent > 0) {
        let agentCount = entries.reduce(
          (count, candidate) =>
            count + (candidate.agentId === entryCopy.agentId ? 1 : 0),
          0
        );

        for (
          let index = 0;
          agentCount >= this.maxEntriesPerAgent && index < entries.length;
        ) {
          if (entries[index]?.agentId === entryCopy.agentId) {
            entries.splice(index, 1);
            agentCount--;
          } else {
            index++;
          }
        }
      }

      while (entries.length >= this.maxEntries) {
        entries.shift();
      }

      entries.push(entryCopy);
      await this.flushAtomic(entries);
    });
  }

  public async listByAgent(
    agentId: string,
    options?: ListMemoryOptions
  ): Promise<MemoryEntry[]> {
    assertListMemoryOptions(options);

    return serializeFileOperation(this.storagePath, async () => {
      const entries = await this.loadEntries();
      return selectMemoryEntries(entries, agentId, options);
    });
  }

  public async countByAgent(agentId: string): Promise<number> {
    return serializeFileOperation(this.storagePath, async () => {
      const entries = await this.loadEntries();
      return entries.filter((entry) => entry.agentId === agentId).length;
    });
  }

  public async clear(): Promise<void> {
    await this.serializeWrite(async () => {
      await this.flushAtomic([]);
    });
  }
}
