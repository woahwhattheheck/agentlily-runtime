import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MEMORY_ENTRIES_PER_AGENT,
  InMemoryMemoryStore,
  type MemoryEntry
} from "../../src/memory/memory-store.js";

const entry = (agentId: string, taskId: string): MemoryEntry => ({
  agentId,
  taskId,
  input: taskId,
  output: null,
  recordedAt: "2026-09-12T00:00:00.000Z"
});

describe("InMemoryMemoryStore maxEntriesPerAgent validation", () => {
  it.each([
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])("rejects invalid maxEntriesPerAgent %s", (maxEntriesPerAgent) => {
    expect(
      () => new InMemoryMemoryStore({ maxEntriesPerAgent })
    ).toThrow(
      new RangeError("maxEntriesPerAgent must be a non-negative integer.")
    );
  });

  it("preserves the documented default per-agent capacity", () => {
    const store = new InMemoryMemoryStore();
    expect(store.maxEntriesPerAgent).toBe(
      DEFAULT_MAX_MEMORY_ENTRIES_PER_AGENT
    );
  });

  it("preserves zero as unbounded per-agent growth", async () => {
    const store = new InMemoryMemoryStore({
      maxEntries: 10,
      maxEntriesPerAgent: 0
    });

    await store.append(entry("agent-a", "task-1"));
    await store.append(entry("agent-a", "task-2"));
    await store.append(entry("agent-a", "task-3"));

    expect(
      (await store.listByAgent("agent-a")).map((item) => item.taskId)
    ).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("continues to evict the oldest entry for a bounded agent", async () => {
    const store = new InMemoryMemoryStore({
      maxEntries: 10,
      maxEntriesPerAgent: 2
    });

    await store.append(entry("agent-a", "task-1"));
    await store.append(entry("agent-b", "task-b"));
    await store.append(entry("agent-a", "task-2"));
    await store.append(entry("agent-a", "task-3"));

    expect(
      (await store.listByAgent("agent-a")).map((item) => item.taskId)
    ).toEqual(["task-2", "task-3"]);
    expect(
      (await store.listByAgent("agent-b")).map((item) => item.taskId)
    ).toEqual(["task-b"]);
  });
});
