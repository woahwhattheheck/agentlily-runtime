import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/index.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

describe("AgentRuntime maxTaskDurationMs validation", () => {
  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    MAX_TIMER_DELAY_MS + 1
  ])("rejects invalid maxTaskDurationMs %s", (maxTaskDurationMs) => {
    expect(
      () =>
        new AgentRuntime({
          runtimeId: "runtime-invalid-timeout",
          maxTaskDurationMs
        })
    ).toThrow(
      new RangeError(
        `TaskRunner timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`
      )
    );
  });

  it.each([0, 1, MAX_TIMER_DELAY_MS])(
    "accepts supported maxTaskDurationMs %s",
    (maxTaskDurationMs) => {
      expect(
        () =>
          new AgentRuntime({
            runtimeId: "runtime-valid-timeout",
            maxTaskDurationMs
          })
      ).not.toThrow();
    }
  );

  it("still allows maxTaskDurationMs to be omitted", () => {
    expect(
      () => new AgentRuntime({ runtimeId: "runtime-no-timeout" })
    ).not.toThrow();
  });
});
