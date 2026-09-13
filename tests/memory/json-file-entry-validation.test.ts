import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeError } from "../../src/errors/runtime-errors.js";
import { JsonFileMemoryStore } from "../../src/memory/memory-store.js";

describe("JsonFileMemoryStore persisted entry validation", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentlily-memory-shape-"));
    filePath = join(tempDir, "memory.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    null,
    7,
    [],
    { agentId: "agent-a", taskId: 7, input: "input", recordedAt: "now" },
    { agentId: "agent-a", taskId: "task-a", input: 7, recordedAt: "now" },
    { agentId: "agent-a", taskId: "task-a", input: "input", recordedAt: 7 }
  ])("rejects malformed persisted entry %j as STORAGE_CORRUPTED", async (entry) => {
    await writeFile(filePath, JSON.stringify([entry]), "utf-8");
    const store = new JsonFileMemoryStore(filePath);

    try {
      await store.size();
      expect.fail("expected malformed storage to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({
        code: "STORAGE_CORRUPTED",
        details: { filePath, entryIndex: 0 }
      });
    }
  });

  it("reports the exact invalid persisted entry index", async () => {
    await writeFile(
      filePath,
      JSON.stringify([
        {
          agentId: "agent-a",
          taskId: "task-a",
          input: "input-a",
          output: { ok: true },
          recordedAt: "2026-09-12T00:00:00.000Z"
        },
        null
      ]),
      "utf-8"
    );

    const store = new JsonFileMemoryStore(filePath);
    await expect(store.listByAgent("agent-a")).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED",
      details: { filePath, entryIndex: 1 }
    });
  });

  it("preserves arbitrary output values and accepts omitted output", async () => {
    await writeFile(
      filePath,
      JSON.stringify([
        {
          agentId: "agent-a",
          taskId: "task-object",
          input: "object output",
          output: { nested: [1, null, "three"] },
          recordedAt: "2026-09-12T00:00:00.000Z"
        },
        {
          agentId: "agent-a",
          taskId: "task-undefined",
          input: "undefined output was omitted by JSON.stringify",
          recordedAt: "2026-09-12T00:00:01.000Z"
        }
      ]),
      "utf-8"
    );

    const store = new JsonFileMemoryStore(filePath);
    const entries = await store.listByAgent("agent-a");

    expect(entries).toHaveLength(2);
    expect(entries[0]?.output).toEqual({ nested: [1, null, "three"] });
    expect(entries[1]).toHaveProperty("output", undefined);
  });
});
