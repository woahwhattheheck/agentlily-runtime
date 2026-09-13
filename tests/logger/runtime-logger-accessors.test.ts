import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleRuntimeLogger,
  InMemoryRuntimeLogger
} from "../../src/logger/runtime-logger.js";

describe("RuntimeLogger metadata accessors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not execute metadata getters while redacting in-memory entries", () => {
    const logger = new InMemoryRuntimeLogger();
    const metadata: Record<string, unknown> = { safe: "value" };
    let getterReads = 0;

    Object.defineProperty(metadata, "computed", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error("metadata getter must not execute");
      }
    });
    Object.defineProperty(metadata, "apiToken", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error("sensitive metadata getter must not execute");
      }
    });

    expect(() => logger.info("with accessors", metadata)).not.toThrow();
    expect(getterReads).toBe(0);
    expect(logger.entries[0]!.metadata).toEqual({
      safe: "value",
      computed: "[Accessor]",
      apiToken: "[REDACTED]"
    });
  });

  it("does not execute nested or array accessors before console emission", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = new ConsoleRuntimeLogger();
    const nested: Record<string, unknown> = {};
    const items: unknown[] = [];
    let getterReads = 0;

    Object.defineProperty(nested, "danger", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error("nested getter must not execute");
      }
    });
    Object.defineProperty(items, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads++;
        throw new Error("array getter must not execute");
      }
    });
    items.length = 1;

    expect(() => logger.info("nested accessors", { nested, items })).not.toThrow();
    expect(getterReads).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith("nested accessors", {
      nested: { danger: "[Accessor]" },
      items: ["[Accessor]"]
    });
  });

  it("contains metadata objects that reject descriptor introspection", () => {
    const logger = new InMemoryRuntimeLogger();
    const { proxy, revoke } = Proxy.revocable({ value: "secret" }, {});
    revoke();

    expect(() =>
      logger.info("revoked proxy", {
        payload: proxy
      })
    ).not.toThrow();
    expect(logger.entries[0]!.metadata).toEqual({
      payload: "[Uninspectable]"
    });
  });
});
