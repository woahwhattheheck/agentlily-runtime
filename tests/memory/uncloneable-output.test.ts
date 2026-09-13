import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "../../src/memory/memory-store.js";

function entryWith(output: unknown) {
  return {
    agentId: "agent-eames",
    taskId: "task-1",
    input: "remember this",
    output,
    recordedAt: "2026-09-13T01:58:00.000Z"
  };
}

describe("memory output defensive cloning", () => {
  it("rejects an output that cannot be safely cloned instead of retaining a live alias", async () => {
    const store = new InMemoryMemoryStore();
    const output: { status: string; callback: () => void; self?: unknown } = {
      status: "original",
      callback: () => undefined
    };
    output.self = output;

    await expect(store.append(entryWith(output))).rejects.toThrow(
      "Memory output must be structurally cloneable or JSON-serializable."
    );

    output.status = "mutated-after-rejection";
    expect(store.size).toBe(0);
    expect(await store.listByAgent("agent-eames")).toEqual([]);
  });

  it("rejects a top-level function output rather than storing the function object by reference", async () => {
    const store = new InMemoryMemoryStore();
    const output = Object.assign(() => "ok", { mutable: "original" });

    await expect(store.append(entryWith(output))).rejects.toThrow(TypeError);

    output.mutable = "mutated";
    expect(store.size).toBe(0);
  });

  it("keeps ordinary cloneable outputs isolated on both append and read", async () => {
    const store = new InMemoryMemoryStore();
    const output = { nested: { status: "original" } };

    await store.append(entryWith(output));
    output.nested.status = "caller-mutated";

    const firstRead = await store.listByAgent("agent-eames");
    expect(firstRead[0]?.output).toEqual({ nested: { status: "original" } });

    const returned = firstRead[0]?.output as { nested: { status: string } };
    returned.nested.status = "reader-mutated";

    const secondRead = await store.listByAgent("agent-eames");
    expect(secondRead[0]?.output).toEqual({ nested: { status: "original" } });
  });
});
