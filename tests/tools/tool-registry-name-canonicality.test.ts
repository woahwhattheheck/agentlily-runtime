import { describe, expect, it } from "vitest";
import { RuntimeError } from "../../src/errors/runtime-errors.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

describe("ToolRegistry tool-name canonicality", () => {
  it.each([" echo", "echo ", "\techo", "echo\n"])(
    "rejects non-canonical tool identity %j before registry mutation",
    (name) => {
      const registry = new ToolRegistry();

      expect(() =>
        registry.register({
          name,
          description: "non-canonical tool",
          execute: () => "should-not-run"
        })
      ).toThrowError(RuntimeError);

      try {
        registry.register({
          name,
          description: "non-canonical tool",
          execute: () => "should-not-run"
        });
        expect.fail("should have thrown");
      } catch (error) {
        const err = error as RuntimeError;
        expect(err.code).toBe("INVALID_TASK");
        expect(err.details).toEqual({ fieldName: "tool.name" });
        expect(err.message).toBe(
          "tool.name must not have leading or trailing whitespace."
        );
      }

      expect(registry.size()).toBe(0);
      expect(registry.list()).toEqual([]);
    }
  );

  it("prevents whitespace aliases from coexisting with a canonical name", () => {
    const registry = new ToolRegistry();
    const canonical = {
      name: "echo",
      description: "canonical echo",
      execute: () => "ok"
    };

    registry.register(canonical);

    expect(() =>
      registry.register({
        name: " echo ",
        description: "whitespace alias",
        execute: () => "alias"
      })
    ).toThrowError(RuntimeError);

    expect(registry.size()).toBe(1);
    expect(registry.list()).toEqual([canonical]);
    expect(registry.get("echo")).toBe(canonical);
    expect(registry.has(" echo ")).toBe(false);
  });
});
