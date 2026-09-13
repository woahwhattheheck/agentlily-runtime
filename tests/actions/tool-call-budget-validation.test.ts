import { describe, expect, it } from "vitest";
import { ActionExecutor } from "../../src/actions/action-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

describe("ActionExecutor maxToolCallsPerTask validation", () => {
  it.each([
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])("rejects invalid maxToolCallsPerTask %s", (maxToolCallsPerTask) => {
    expect(
      () => new ActionExecutor(new ToolRegistry(), maxToolCallsPerTask)
    ).toThrow(new RangeError("maxToolCallsPerTask must be an integer."));
  });

  it.each([-100, -1, 0, 1, 100])(
    "continues to accept integer maxToolCallsPerTask %s",
    (maxToolCallsPerTask) => {
      expect(
        () => new ActionExecutor(new ToolRegistry(), maxToolCallsPerTask)
      ).not.toThrow();
    }
  );
});
