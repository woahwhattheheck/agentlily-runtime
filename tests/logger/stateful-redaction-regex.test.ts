import { describe, expect, it, vi } from "vitest";
import {
  ConsoleRuntimeLogger,
  InMemoryRuntimeLogger
} from "../../src/logger/runtime-logger.js";

const metadata = {
  secretOne: "first-secret",
  secretTwo: "second-secret",
  nested: {
    secretThree: "third-secret",
    secretFour: "fourth-secret",
    visible: "safe"
  }
};

const expected = {
  secretOne: "[REDACTED]",
  secretTwo: "[REDACTED]",
  nested: {
    secretThree: "[REDACTED]",
    secretFour: "[REDACTED]",
    visible: "safe"
  }
};

describe.each([
  ["global", /secret/gi],
  ["sticky", /secret/yi]
] as const)("stateful %s redactKeys", (_label, redactKeys) => {
  it("redacts every repeated matching key in ConsoleRuntimeLogger", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = new ConsoleRuntimeLogger({ redactKeys });

    logger.info("stateful redaction", metadata);

    expect(infoSpy.mock.calls[0]![1]).toEqual(expected);
    infoSpy.mockRestore();
  });

  it("redacts every repeated matching key in InMemoryRuntimeLogger", () => {
    const logger = new InMemoryRuntimeLogger({ redactKeys });

    logger.info("stateful redaction", metadata);

    expect(logger.entries[0]!.metadata).toEqual(expected);
  });

  it("does not mutate the caller-owned regex lastIndex", () => {
    redactKeys.lastIndex = 3;
    const logger = new InMemoryRuntimeLogger({ redactKeys });

    logger.info("preserve regex state", metadata);

    expect(redactKeys.lastIndex).toBe(3);
  });
});
