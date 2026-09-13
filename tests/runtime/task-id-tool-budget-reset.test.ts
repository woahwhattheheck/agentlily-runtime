import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";

const task = (taskId: string, toolName: string) => ({
  taskId,
  agentId: "agent-budget-reuse",
  toolName,
  input: "run",
  payload: {}
});

describe("AgentRuntime task ID tool-call budget lifecycle", () => {
  it("gives a completed reused task ID a fresh tool-call budget", async () => {
    const runtime = new AgentRuntime({
      runtimeId: "rt-budget-reuse-success",
      maxToolCallsPerTask: 1
    });
    let calls = 0;
    runtime.registerTool({
      name: "ping",
      description: "Counts executions",
      execute: () => {
        calls += 1;
        return { calls };
      }
    });

    await runtime.start();

    await expect(
      runtime.executeTask(task("reused-task", "ping"))
    ).resolves.toBeDefined();
    expect(
      runtime.getDependencies().actionExecutor.getToolCallCount("reused-task")
    ).toBe(0);

    await expect(
      runtime.executeTask(task("reused-task", "ping"))
    ).resolves.toBeDefined();
    expect(calls).toBe(2);
    expect(
      runtime.getDependencies().actionExecutor.getToolCallCount("reused-task")
    ).toBe(0);
  });

  it("gives a failed reused task ID a fresh tool-call budget", async () => {
    const runtime = new AgentRuntime({
      runtimeId: "rt-budget-reuse-failure",
      maxToolCallsPerTask: 1
    });
    runtime.registerTool({
      name: "fail",
      description: "Fails after consuming its tool call",
      execute: () => {
        throw new Error("deliberate failure");
      }
    });
    runtime.registerTool({
      name: "recover",
      description: "Succeeds on reused task ID",
      execute: () => ({ recovered: true })
    });

    await runtime.start();

    await expect(
      runtime.executeTask(task("failed-reuse", "fail"))
    ).rejects.toThrow("deliberate failure");
    expect(
      runtime.getDependencies().actionExecutor.getToolCallCount("failed-reuse")
    ).toBe(0);

    await expect(
      runtime.executeTask(task("failed-reuse", "recover"))
    ).resolves.toBeDefined();
    expect(
      runtime.getDependencies().actionExecutor.getToolCallCount("failed-reuse")
    ).toBe(0);
  });
});
