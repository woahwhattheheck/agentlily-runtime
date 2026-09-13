import { describe, expect, it } from "vitest";
import {
  createRuntimeDependencies,
  InMemoryMemoryStore,
  JsonFileMemoryStore
} from "../src/index.js";

describe("runtime memoryStoragePath selection", () => {
  it.each(["", "   ", "\t\n"])(
    "rejects a blank configured storage path %j instead of silently using memory",
    (memoryStoragePath) => {
      expect(() =>
        createRuntimeDependencies({
          runtimeId: "runtime-storage-path",
          memoryStoragePath
        })
      ).toThrow(new TypeError("memoryStoragePath must be a non-empty string."));
    }
  );

  it("rejects a non-string storage path at the runtime boundary", () => {
    expect(() =>
      createRuntimeDependencies({
        runtimeId: "runtime-storage-path-type",
        memoryStoragePath: 42 as unknown as string
      })
    ).toThrow(new TypeError("memoryStoragePath must be a non-empty string."));
  });

  it("selects the file-backed store for a non-empty configured path", () => {
    const dependencies = createRuntimeDependencies({
      runtimeId: "runtime-file-memory",
      memoryStoragePath: "state/agent-memory.json"
    });

    expect(dependencies.memoryStore).toBeInstanceOf(JsonFileMemoryStore);
    expect(
      (dependencies.memoryStore as JsonFileMemoryStore).getFilePath()
    ).toBe("state/agent-memory.json");
  });

  it("keeps an explicit custom memory store authoritative", () => {
    const memoryStore = new InMemoryMemoryStore();
    const dependencies = createRuntimeDependencies({
      runtimeId: "runtime-custom-memory",
      memoryStore,
      memoryStoragePath: ""
    });

    expect(dependencies.memoryStore).toBe(memoryStore);
  });
});
