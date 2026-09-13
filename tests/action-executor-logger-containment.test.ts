import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  ToolRegistry,
  UnconfiguredModelProvider
} from "../src/index.js";
import type { RuntimeContext, RuntimeLogger } from "../src/index.js";

function createMockContext(taskId: string): RuntimeContext {
  return {
    runtimeId: "runtime-logger-containment",
    taskId,
    agent: new AgentInstanceManager().getOrCreate("test-agent"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: "2026-09-13T04:00:00.000Z"
  };
}

describe("ActionExecutor logger containment", () => {
  it("preserves a successful tool result when post-success logging throws", async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: "side-effecting-tool",
      description: "Returns success after recording one execution.",
      execute() {
        executions += 1;
        return "committed";
      }
    });

    const logger: RuntimeLogger = {
      info() {
        throw new Error("logger unavailable");
      },
      warn() {},
      debug() {},
      error() {}
    };
    const executor = new ActionExecutor(registry, logger);
    const context = createMockContext("task-logger-containment");

    await expect(
      executor.execute("side-effecting-tool", {}, context)
    ).resolves.toBe("committed");
    expect(executions).toBe(1);
    expect(executor.getToolCallCount(context.taskId)).toBe(1);
  });
});
