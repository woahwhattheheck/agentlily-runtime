import { describe, expect, it, vi } from "vitest";
import {
  ConsoleRuntimeLogger,
  InMemoryRuntimeLogger
} from "../../src/logger/runtime-logger.js";

function selfReferentialMetadata(): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    name: "self",
    apiToken: "secret-token"
  };
  metadata.self = metadata;
  return metadata;
}

function mutuallyReferentialMetadata(): Record<string, unknown> {
  const left: Record<string, unknown> = { name: "left" };
  const right: Record<string, unknown> = {
    name: "right",
    password: "secret-password"
  };
  left.right = right;
  right.left = left;
  return left;
}

describe("cycle-safe logger metadata", () => {
  it("redacts and emits self-referential metadata in ConsoleRuntimeLogger", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = new ConsoleRuntimeLogger();

    expect(() =>
      logger.info("self cycle", selfReferentialMetadata())
    ).not.toThrow();
    expect(infoSpy.mock.calls[0]![1]).toEqual({
      name: "self",
      apiToken: "[REDACTED]",
      self: "[Circular]"
    });

    infoSpy.mockRestore();
  });

  it("redacts and stores mutual object cycles in InMemoryRuntimeLogger", () => {
    const logger = new InMemoryRuntimeLogger();

    expect(() =>
      logger.info("mutual cycle", mutuallyReferentialMetadata())
    ).not.toThrow();
    expect(logger.entries[0]!.metadata).toEqual({
      name: "left",
      right: {
        name: "right",
        password: "[REDACTED]",
        left: "[Circular]"
      }
    });
  });

  it("handles cycles routed through arrays", () => {
    const logger = new InMemoryRuntimeLogger();
    const metadata: Record<string, unknown> = { name: "array-cycle" };
    const items: unknown[] = [metadata];
    metadata.items = items;

    expect(() => logger.info("array cycle", metadata)).not.toThrow();
    expect(logger.entries[0]!.metadata).toEqual({
      name: "array-cycle",
      items: ["[Circular]"]
    });
  });

  it("serializes repeated shared references normally when they are not cyclic", () => {
    const logger = new InMemoryRuntimeLogger();
    const shared = { token: "shared-secret", visible: "value" };

    logger.info("shared aliases", { first: shared, second: shared });

    expect(logger.entries[0]!.metadata).toEqual({
      first: { token: "[REDACTED]", visible: "value" },
      second: { token: "[REDACTED]", visible: "value" }
    });
  });
});
