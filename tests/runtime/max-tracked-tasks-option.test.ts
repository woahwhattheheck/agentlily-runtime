import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";

describe("RuntimeOptions.maxTrackedTasks", () => {
  it("bounds retained tool-call counters through normal runtime wiring", async () => {
    const runtime = new AgentRuntime({
      runtimeId: "tracked-task-retention",
      maxTrackedTasks: 2,
      tools: [
        {
          name: "ping",
          description: "Returns pong",
          execute: () => "pong"
        }
      ]
    });

    await runtime.start();
    try {
      for (const taskId of ["task-a", "task-b", "task-c"]) {
        await runtime.executeTask({
          taskId,
          agentId: "retention-agent",
          toolName: "ping",
          input: "ping",
          payload: {}
        });
      }

      const executor = runtime.getDependencies().actionExecutor;
      expect(executor.getToolCallCount("task-a")).toBe(0);
      expect(executor.getToolCallCount("task-b")).toBe(1);
      expect(executor.getToolCallCount("task-c")).toBe(1);
    } finally {
      await runtime.stop();
    }
  });
});
