import { describe, expect, it } from "vitest";
import { InMemoryRuntimeLogger } from "../../src/logger/runtime-logger.js";

describe("InMemoryRuntimeLogger maxEntries validation", () => {
  it.each([
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])("rejects invalid maxEntries %s", (maxEntries) => {
    expect(() => new InMemoryRuntimeLogger({ maxEntries })).toThrow(
      new RangeError("maxEntries must be a non-negative integer.")
    );
  });

  it("preserves maxEntries 0 as explicitly unbounded", () => {
    const logger = new InMemoryRuntimeLogger({ maxEntries: 0 });

    logger.info("first");
    logger.info("second");
    logger.info("third");

    expect(logger.entries.map((entry) => entry.message)).toEqual([
      "first",
      "second",
      "third"
    ]);
  });

  it("evicts the oldest entry for positive integer capacities", () => {
    const logger = new InMemoryRuntimeLogger({ maxEntries: 2 });

    logger.info("first");
    logger.warn("second");
    logger.error("third");

    expect(logger.entries).toMatchObject([
      { level: "warn", message: "second" },
      { level: "error", message: "third" }
    ]);
  });

  it("retains the default all-level behavior while validating capacity", () => {
    const logger = new InMemoryRuntimeLogger({ maxEntries: 4 });

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(logger.entries.map((entry) => entry.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error"
    ]);
  });
});
