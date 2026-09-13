import { describe, expect, it } from "vitest";
import { createRuntimeDependencies } from "../../src/runtime/bootstrap.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

describe("ActionExecutor retention wiring", () => {
  it("forwards RuntimeOptions.maxTrackedTasks into the executor", async () => {
    const deps = createRuntimeDependencies({
      runtimeId: "retention-wiring",
      maxTrackedTasks: 2,
      tools: [
        {
          name: "ping",
          description: "ping",
          execute: () => "pong"
        }
      ]
    });

    const context = (taskId: string): RuntimeContext => ({
      runtimeId: "retention-wiring",
      taskId,
      agent: deps.agentManager.getOrCreate("agent"),
      memory: deps.memoryStore,
      modelProvider: deps.modelProvider,
      state: deps.stateStore,
      now: new Date().toISOString()
    });

    await deps.actionExecutor.execute("ping", {}, context("task-a"));
    await deps.actionExecutor.execute("ping", {}, context("task-b"));
    expect(deps.actionExecutor.getToolCallCount("task-a")).toBe(1);

    await deps.actionExecutor.execute("ping", {}, context("task-c"));

    expect(deps.actionExecutor.getToolCallCount("task-a")).toBe(0);
    expect(deps.actionExecutor.getToolCallCount("task-b")).toBe(1);
    expect(deps.actionExecutor.getToolCallCount("task-c")).toBe(1);
  });
});
