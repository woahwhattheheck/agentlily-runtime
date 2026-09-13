import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RuntimeError } from "../errors/runtime-errors.js";

export interface MemoryEntry {
  agentId: string;
  taskId: string;
  input: string;
  output: unknown;
  recordedAt: string;
}

export interface ListMemoryOptions {
  limit?: number;
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

const cloneOutput = (val: unknown): unknown => {
  if (val === null || typeof val !== "object") {
    return val;
  }
  try {
    return structuredClone(val);
  } catch {
    try {
      return JSON.parse(JSON.stringify(val));
    } catch {
      return val;
    }
  }
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
    const matching = this.entries.filter((entry) => entry.agentId === agentId);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? matching.length;

    const slice = matching.slice(offset, offset + limit);
    return slice.map((entry) => ({
      ...entry,
      output: cloneOutput(entry.output)
    }));
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

  public readonly maxEntries: number;
  public readonly maxEntriesPerAgent: number;

  public constructor(filePath: string, options: JsonFileMemoryStoreOptions = {}) {
    this.filePath = filePath;
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
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public get capacity(): number {
    return this.maxEntries;
  }

  private async loadEntries(): Promise<MemoryEntry[]> {
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

    return parsed as MemoryEntry[];
  }

  private async flushAtomic(entries: MemoryEntry[]): Promise<void> {
    const dir = dirname(this.filePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    const data = JSON.stringify(entries, null, 2);

    try {
      await writeFile(tempPath, data, "utf-8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async size(): Promise<number> {
    return serializeFileOperation(this.filePath, async () => {
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

    await serializeFileOperation(this.filePath, async () => {
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
    return serializeFileOperation(this.filePath, async () => {
      const entries = await this.loadEntries();
      const matching = entries.filter((entry) => entry.agentId === agentId);
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? matching.length;
      return matching.slice(offset, offset + limit).map((entry) => ({
        ...entry,
        output: cloneOutput(entry.output)
      }));
    });
  }

  public async countByAgent(agentId: string): Promise<number> {
    return serializeFileOperation(this.filePath, async () => {
      const entries = await this.loadEntries();
      return entries.filter((entry) => entry.agentId === agentId).length;
    });
  }

  public async clear(): Promise<void> {
    await serializeFileOperation(this.filePath, async () => {
      await this.flushAtomic([]);
    });
  }
}
