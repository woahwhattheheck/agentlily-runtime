import { describe, expect, it } from "vitest";
import {
  ConsoleRuntimeLogger,
  InMemoryRuntimeLogger,
  type ConsoleRuntimeLoggerOptions,
  type InMemoryRuntimeLoggerOptions
} from "../../src/logger/runtime-logger.js";

const invalidLevels: unknown[] = [
  "",
  "verbose",
  "toString",
  "constructor",
  null,
  0,
  false,
  {},
  []
];

function consoleOptions(level: unknown): ConsoleRuntimeLoggerOptions {
  return { level } as unknown as ConsoleRuntimeLoggerOptions;
}

function memoryOptions(level: unknown): InMemoryRuntimeLoggerOptions {
  return { level } as unknown as InMemoryRuntimeLoggerOptions;
}

describe("Runtime logger level validation", () => {
  it.each(invalidLevels)("ConsoleRuntimeLogger rejects invalid level %p", (level) => {
    expect(() => new ConsoleRuntimeLogger(consoleOptions(level))).toThrow(
      new RangeError("level must be one of: debug, info, warn, error.")
    );
  });

  it.each(invalidLevels)("InMemoryRuntimeLogger rejects invalid level %p", (level) => {
    expect(() => new InMemoryRuntimeLogger(memoryOptions(level))).toThrow(
      new RangeError("level must be one of: debug, info, warn, error.")
    );
  });

  it.each(["debug", "info", "warn", "error"] as const)(
    "accepts the supported level %s",
    (level) => {
      expect(() => new ConsoleRuntimeLogger({ level })).not.toThrow();
      expect(() => new InMemoryRuntimeLogger({ level })).not.toThrow();
    }
  );

  it("preserves constructor defaults when level is omitted", () => {
    expect(new ConsoleRuntimeLogger().level).toBe("info");
    expect(new InMemoryRuntimeLogger().level).toBe("debug");
  });
});
