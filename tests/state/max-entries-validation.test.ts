import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStateStore } from "../../src/state/runtime-state.js";

describe("InMemoryRuntimeStateStore maxEntries validation", () => {
  it.each([
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])("rejects invalid maxEntries %s", (maxEntries) => {
    expect(() => new InMemoryRuntimeStateStore({ maxEntries })).toThrow(
      new RangeError("maxEntries must be a non-negative integer.")
    );
  });

  it("preserves maxEntries 0 as explicitly unbounded", async () => {
    const store = new InMemoryRuntimeStateStore({ maxEntries: 0 });

    for (let index = 0; index < 3; index++) {
      await store.put(`key-${index}`, index);
    }

    expect(await store.keys()).toEqual(["key-0", "key-1", "key-2"]);
  });

  it("continues to accept positive integer capacities", async () => {
    const store = new InMemoryRuntimeStateStore({ maxEntries: 1 });

    await store.put("first", 1);
    await store.put("second", 2);

    expect(await store.keys()).toEqual(["second"]);
  });
});
