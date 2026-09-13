import { describe, expect, it } from "vitest";
import { AgentRuntime, RuntimeEventBus } from "../src/index.js";

function createThrowingLogger() {
  const fail = (): never => {
    throw new Error("logger failed");
  };

  return {
    info: fail,
    warn: fail,
    debug: fail,
    error: fail
  };
}

describe("AgentRuntime logger containment", () => {
  it("starts successfully when an injected logger throws", async () => {
    const eventBus = new RuntimeEventBus();
    const events: string[] = [];
    eventBus.on("runtime.started", (event) => events.push(event.name));

    const runtime = new AgentRuntime({
      runtimeId: "runtime-throwing-start-logger",
      logger: createThrowingLogger(),
      eventBus
    });

    await expect(runtime.start()).resolves.toBeUndefined();

    expect(runtime.isRunning()).toBe(true);
    expect(events).toEqual(["runtime.started"]);
  });

  it("preserves successful task results when runtime logging throws", async () => {
    const eventBus = new RuntimeEventBus();
    const events: string[] = [];
    let executions = 0;
    eventBus.on("runtime.task.completed", (event) => events.push(event.name));
    eventBus.on("runtime.task.failed", (event) => events.push(event.name));

    const runtime = new AgentRuntime({
      runtimeId: "runtime-throwing-success-logger",
      logger: createThrowingLogger(),
      eventBus
    });
    runtime.registerTool({
      name: "commit-once",
      description: "Returns a committed result.",
      execute() {
        executions += 1;
        return { committed: true };
      }
    });

    await runtime.start();
    const result = await runtime.executeTask<unknown, { committed: boolean }>({
      taskId: "task-logger-success",
      agentId: "agent-logger-success",
      toolName: "commit-once",
      input: "Commit once",
      payload: {}
    });

    expect(result.output).toEqual({ committed: true });
    expect(executions).toBe(1);
    expect(events).toEqual(["runtime.task.completed"]);
  });

  it("preserves the original task error when failure logging throws", async () => {
    const eventBus = new RuntimeEventBus();
    const events: string[] = [];
    const original = new Error("tool failed");
    eventBus.on("runtime.task.failed", (event) => events.push(event.name));

    const runtime = new AgentRuntime({
      runtimeId: "runtime-throwing-failure-logger",
      logger: createThrowingLogger(),
      eventBus
    });
    runtime.registerTool({
      name: "fail",
      description: "Throws the original task error.",
      execute() {
        throw original;
      }
    });

    await runtime.start();

    await expect(
      runtime.executeTask({
        taskId: "task-logger-failure",
        agentId: "agent-logger-failure",
        toolName: "fail",
        input: "Fail once",
        payload: {}
      })
    ).rejects.toBe(original);
    expect(events).toEqual(["runtime.task.failed"]);
  });

  it("stops and emits its terminal event when shutdown logging throws", async () => {
    const eventBus = new RuntimeEventBus();
    const events: string[] = [];
    eventBus.on("runtime.stopped", (event) => events.push(event.name));

    const runtime = new AgentRuntime({
      runtimeId: "runtime-throwing-stop-logger",
      logger: createThrowingLogger(),
      eventBus
    });

    await runtime.start();
    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(runtime.isRunning()).toBe(false);
    expect(events).toEqual(["runtime.stopped"]);
  });
});
