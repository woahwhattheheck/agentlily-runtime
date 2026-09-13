import { describe, expect, it } from "vitest";
import { RuntimeError } from "../../src/errors/runtime-errors.js";
import { TaskRunner } from "../../src/tasks/task-runner.js";

function createHarness() {
  let executeCalls = 0;
  let appendCalls = 0;

  const executor = {
    execute: async () => {
      executeCalls++;
      return "ok";
    }
  };
  const memoryStore = {
    append: async () => {
      appendCalls++;
    },
    listByAgent: async () => []
  };

  return {
    runner: new TaskRunner(executor as any, memoryStore as any),
    getExecuteCalls: () => executeCalls,
    getAppendCalls: () => appendCalls
  };
}

function createTask(taskId = "task-1", agentId = "agent-1") {
  return {
    taskId,
    agentId,
    toolName: "echo",
    input: "hello",
    payload: {}
  };
}

function createContext(taskId = "task-1", agentId = "agent-1") {
  return {
    taskId,
    agent: { agentId }
  } as any;
}

describe("TaskRunner direct-call context identity", () => {
  it("rejects a taskId/context.taskId mismatch before tool execution or persistence", async () => {
    const harness = createHarness();

    await expect(
      harness.runner.run(createTask("task-1"), createContext("task-2"))
    ).rejects.toMatchObject({
      code: "INVALID_TASK",
      message: "task.taskId must match context.taskId.",
      details: { taskId: "task-1", contextTaskId: "task-2" }
    } satisfies Partial<RuntimeError>);

    expect(harness.getExecuteCalls()).toBe(0);
    expect(harness.getAppendCalls()).toBe(0);
  });

  it("rejects an agentId/context agent mismatch before tool execution or persistence", async () => {
    const harness = createHarness();

    await expect(
      harness.runner.run(createTask("task-1", "agent-1"), createContext("task-1", "agent-2"))
    ).rejects.toMatchObject({
      code: "INVALID_TASK",
      message: "task.agentId must match context.agent.agentId.",
      details: { agentId: "agent-1", contextAgentId: "agent-2" }
    } satisfies Partial<RuntimeError>);

    expect(harness.getExecuteCalls()).toBe(0);
    expect(harness.getAppendCalls()).toBe(0);
  });

  it("preserves execution and persistence when task and context identities match", async () => {
    const harness = createHarness();

    const result = await harness.runner.run(
      createTask("task-1", "agent-1"),
      createContext("task-1", "agent-1")
    );

    expect(result).toMatchObject({
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "echo",
      output: "ok"
    });
    expect(harness.getExecuteCalls()).toBe(1);
    expect(harness.getAppendCalls()).toBe(1);
  });
});
