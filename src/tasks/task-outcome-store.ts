import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TaskOutcomeState = "started" | "completed";

export interface TaskOutcomeRecord {
  agentId: string;
  taskId: string;
  state: TaskOutcomeState;
  updatedAt: string;
}

export type BeginTaskOutcomeResult = "started" | "unknown";

export interface TaskOutcomeStore {
  /**
   * Atomically begin one logical task execution.
   *
   * A recovered `started` record means an earlier execution may already have
   * produced an external side effect, so callers must not execute the tool
   * again. A completed record may be replaced with a new started record because
   * completed task IDs are intentionally reusable by the runtime.
   */
  begin(agentId: string, taskId: string, startedAt: string): Promise<BeginTaskOutcomeResult>;
  /** Mark a previously started task as durably completed. */
  complete(agentId: string, taskId: string, completedAt: string): Promise<void>;
}

const outcomeKey = (agentId: string, taskId: string): string => `${agentId}\u0000${taskId}`;

export class InMemoryTaskOutcomeStore implements TaskOutcomeStore {
  private readonly records = new Map<string, TaskOutcomeRecord>();

  public async begin(
    agentId: string,
    taskId: string,
    startedAt: string
  ): Promise<BeginTaskOutcomeResult> {
    const key = outcomeKey(agentId, taskId);
    const existing = this.records.get(key);
    if (existing?.state === "started") {
      return "unknown";
    }
    this.records.set(key, {
      agentId,
      taskId,
      state: "started",
      updatedAt: startedAt
    });
    return "started";
  }

  public async complete(
    agentId: string,
    taskId: string,
    completedAt: string
  ): Promise<void> {
    const key = outcomeKey(agentId, taskId);
    const existing = this.records.get(key);
    if (existing === undefined) {
      throw new Error(`Task outcome journal has no started record for "${taskId}".`);
    }
    this.records.set(key, {
      agentId,
      taskId,
      state: "completed",
      updatedAt: completedAt
    });
  }
}

export interface JsonFileTaskOutcomeStoreOptions {
  /**
   * Maximum completed records retained. Started/ambiguous records are never
   * evicted automatically because doing so would reopen duplicate side effects.
   * Default: 10,000.
   */
  maxCompletedRecords?: number;
}

const DEFAULT_MAX_COMPLETED_OUTCOMES = 10_000;
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

const isTaskOutcomeRecord = (value: unknown): value is TaskOutcomeRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.agentId === "string" &&
    typeof candidate.taskId === "string" &&
    (candidate.state === "started" || candidate.state === "completed") &&
    typeof candidate.updatedAt === "string"
  );
};

export class JsonFileTaskOutcomeStore implements TaskOutcomeStore {
  private readonly filePath: string;
  public readonly maxCompletedRecords: number;

  public constructor(
    filePath: string,
    options: JsonFileTaskOutcomeStoreOptions = {}
  ) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("Task outcome storage path must be a non-empty string.");
    }
    const maxCompletedRecords =
      options.maxCompletedRecords ?? DEFAULT_MAX_COMPLETED_OUTCOMES;
    if (!Number.isInteger(maxCompletedRecords) || maxCompletedRecords < 0) {
      throw new RangeError("maxCompletedRecords must be a non-negative integer.");
    }
    this.filePath = filePath;
    this.maxCompletedRecords = maxCompletedRecords;
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async begin(
    agentId: string,
    taskId: string,
    startedAt: string
  ): Promise<BeginTaskOutcomeResult> {
    return serializeFileOperation(this.filePath, async () => {
      const records = await this.loadRecords();
      const index = records.findIndex(
        (record) => record.agentId === agentId && record.taskId === taskId
      );
      if (index !== -1 && records[index]?.state === "started") {
        return "unknown";
      }

      const started: TaskOutcomeRecord = {
        agentId,
        taskId,
        state: "started",
        updatedAt: startedAt
      };
      if (index === -1) {
        records.push(started);
      } else {
        records[index] = started;
      }
      this.trimCompleted(records);
      await this.flushAtomic(records);
      return "started";
    });
  }

  public async complete(
    agentId: string,
    taskId: string,
    completedAt: string
  ): Promise<void> {
    await serializeFileOperation(this.filePath, async () => {
      const records = await this.loadRecords();
      const index = records.findIndex(
        (record) => record.agentId === agentId && record.taskId === taskId
      );
      if (index === -1) {
        throw new Error(`Task outcome journal has no started record for "${taskId}".`);
      }
      records[index] = {
        agentId,
        taskId,
        state: "completed",
        updatedAt: completedAt
      };
      this.trimCompleted(records);
      await this.flushAtomic(records);
    });
  }

  private trimCompleted(records: TaskOutcomeRecord[]): void {
    if (this.maxCompletedRecords === 0) {
      for (let index = records.length - 1; index >= 0; index--) {
        if (records[index]?.state === "completed") {
          records.splice(index, 1);
        }
      }
      return;
    }

    let completedCount = records.reduce(
      (count, record) => count + (record.state === "completed" ? 1 : 0),
      0
    );
    for (
      let index = 0;
      completedCount > this.maxCompletedRecords && index < records.length;
    ) {
      if (records[index]?.state === "completed") {
        records.splice(index, 1);
        completedCount--;
      } else {
        index++;
      }
    }
  }

  private async loadRecords(): Promise<TaskOutcomeRecord[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = await readFile(this.filePath, "utf-8");
    if (raw.trim().length === 0) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((record) => !isTaskOutcomeRecord(record))) {
      throw new Error(`Corrupted task outcome journal at ${this.filePath}.`);
    }
    return parsed;
  }

  private async flushAtomic(records: TaskOutcomeRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(records, null, 2), "utf-8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
