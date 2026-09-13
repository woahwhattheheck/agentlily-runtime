import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { createRuntimeDependencies } from "../../src/runtime/bootstrap.js";
import type { RuntimeOptions } from "../../src/runtime/types.js";

describe("runtimeId validation", () => {
  it.each(["", " \t\n", 123, null, undefined])(
    "rejects invalid runtimeId %p before dependency composition",
    (runtimeId) => {
      const options = { runtimeId } as unknown as RuntimeOptions;

      expect(() => createRuntimeDependencies(options)).toThrow(
        new TypeError("runtimeId must be a non-empty string.")
      );
      expect(() => new AgentRuntime(options)).toThrow(
        new TypeError("runtimeId must be a non-empty string.")
      );
    }
  );

  it("preserves valid runtime identifiers and dependency wiring", () => {
    const runtime = new AgentRuntime({ runtimeId: "runtime-audit-1" });
    const dependencies = runtime.getDependencies();

    expect(dependencies.toolRegistry).toBeDefined();
    expect(dependencies.eventBus).toBeDefined();
    expect(dependencies.logger).toBeDefined();
  });
});
