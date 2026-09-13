import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";

describe("RuntimeOptions.maxTaskDurationMs", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid timeout value %s",
    (maxTaskDurationMs) => {
      expect(
        () =>
          new AgentRuntime({
            runtimeId: "invalid-task-timeout",
            maxTaskDurationMs
          })
      ).toThrowError(
        expect.objectContaining({
          name: "RangeError",
          message: "timeoutMs must be a positive integer."
        })
      );
    }
  );

  it("accepts an omitted timeout and positive integer timeout", () => {
    expect(
      () =>
        new AgentRuntime({
          runtimeId: "unbounded-task-timeout"
        })
    ).not.toThrow();

    expect(
      () =>
        new AgentRuntime({
          runtimeId: "bounded-task-timeout",
          maxTaskDurationMs: 25
        })
    ).not.toThrow();
  });
});
