import { describe, expect, it } from "vitest";
import { createRuntimeDependencies } from "../../src/runtime/bootstrap.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

const contextFor = (
  deps: ReturnType<typeof createRuntimeDependencies>,
  taskId: string
): RuntimeContext => ({
  runtimeId: "retention-option-runtime",
  taskId,
  agent: deps.agentManager.getOrCreate("agent"),
  memory: deps.memoryStore,
  modelProvider: deps.modelProvider,
  state: deps.stateStore,
  now: new Date().toISOString()
});

describe("RuntimeOptions.maxTrackedTasks", () => {
  it("wires the public option into ActionExecutor FIFO retention", async () => {
    const deps = createRuntimeDependencies({
      runtimeId: "retention-option-runtime",
      maxTrackedTasks: 2,
      tools: [
        {
          name: "ping",
          description: "ping",
          execute: async () => "pong"
        }
      ]
    });

    await deps.actionExecutor.execute(
      "ping",
      {},
      contextFor(deps, "task-a")
    );
    await deps.actionExecutor.execute(
      "ping",
      {},
      contextFor(deps, "task-b")
    );
    await deps.actionExecutor.execute(
      "ping",
      {},
      contextFor(deps, "task-c")
    );

    expect(deps.actionExecutor.getToolCallCount("task-a")).toBe(0);
    expect(deps.actionExecutor.getToolCallCount("task-b")).toBe(1);
    expect(deps.actionExecutor.getToolCallCount("task-c")).toBe(1);
  });

  it("preserves ActionExecutor validation at the public runtime boundary", () => {
    expect(() =>
      createRuntimeDependencies({
        runtimeId: "invalid-retention-option",
        maxTrackedTasks: 0
      })
    ).toThrow("maxTrackedTasks must be a positive integer.");
  });
});
