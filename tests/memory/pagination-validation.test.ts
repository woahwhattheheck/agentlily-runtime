import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryMemoryStore,
  JsonFileMemoryStore,
  type ListMemoryOptions,
  type MemoryEntry,
  type MemoryStore
} from "../../src/memory/memory-store.js";

const entry = (taskId: string): MemoryEntry => ({
  agentId: "agent-a",
  taskId,
  input: taskId,
  output: { taskId },
  recordedAt: "2026-09-12T00:00:00.000Z"
});

const invalidPaginationValues = [
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY
];

async function seed(store: MemoryStore): Promise<void> {
  await store.append(entry("task-1"));
  await store.append(entry("task-2"));
  await store.append(entry("task-3"));
}

async function expectValidPagination(store: MemoryStore): Promise<void> {
  await seed(store);

  expect(
    (await store.listByAgent("agent-a", { offset: 1, limit: 1 })).map(
      (item) => item.taskId
    )
  ).toEqual(["task-2"]);
  expect(await store.listByAgent("agent-a", { limit: 0 })).toEqual([]);
  expect(
    (await store.listByAgent("agent-a")).map((item) => item.taskId)
  ).toEqual(["task-1", "task-2", "task-3"]);
}

async function expectInvalidPagination(store: MemoryStore): Promise<void> {
  for (const offset of invalidPaginationValues) {
    await expect(
      store.listByAgent("agent-a", { offset })
    ).rejects.toThrow(
      new RangeError("offset must be a non-negative integer.")
    );
  }

  for (const limit of invalidPaginationValues) {
    await expect(
      store.listByAgent("agent-a", { limit })
    ).rejects.toThrow(
      new RangeError("limit must be a non-negative integer.")
    );
  }
}

describe("memory list pagination validation", () => {
  let tempFilePath: string;

  beforeEach(() => {
    tempFilePath = join(
      tmpdir(),
      `agentlily-pagination-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "memory.json"
    );
  });

  afterEach(async () => {
    await rm(dirname(tempFilePath), { recursive: true, force: true });
  });

  it("validates pagination and preserves normal slicing in memory", async () => {
    const store = new InMemoryMemoryStore();
    await expectInvalidPagination(store);
    await expectValidPagination(store);
  });

  it("validates pagination and preserves normal slicing in JsonFile storage", async () => {
    const store = new JsonFileMemoryStore(tempFilePath);
    await expectInvalidPagination(store);
    await expectValidPagination(store);
  });

  it("rejects invalid JsonFile pagination before reading backend contents", async () => {
    await mkdir(dirname(tempFilePath), { recursive: true });
    await writeFile(tempFilePath, "corrupt-json{{", "utf-8");

    const store = new JsonFileMemoryStore(tempFilePath);
    const invalidOptions: ListMemoryOptions = { offset: -1 };

    await expect(
      store.listByAgent("agent-a", invalidOptions)
    ).rejects.toThrow(
      new RangeError("offset must be a non-negative integer.")
    );
  });
});
