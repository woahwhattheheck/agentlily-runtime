import { describe, expect, it } from "vitest";
import { AgentRuntime, RuntimeEventBus } from "../../src/index.js";

describe("AgentRuntime task timeout", () => {
  it("keeps a timed-out task reserved until the underlying tool settles", async () => {
    const eventBus = new RuntimeEventBus();
    const failures: Array<{ taskId: string; reason: string }> = [];
    let releaseFirst!: () => void;
    let calls = 0;

    eventBus.on("runtime.task.failed", (event) => {
      failures.push({
        taskId: event.payload.taskId,
        reason: event.payload.reason
      });
    });

    const runtime = new AgentRuntime({
      runtimeId: "runtime-task-timeout",
      eventBus,
      maxTaskDurationMs: 10,
      maxToolCallsPerTask: 1
    });
    runtime.registerTool({
      name: "slow-once",
      description: "Times out once, then succeeds on retry.",
      execute() {
        calls++;
        if (calls === 1) {
          return new Promise<string>((resolve) => {
            releaseFirst = () => resolve("late-result");
          });
        }
        return "retry-result";
      }
    });

    await runtime.start();

    const task = {
      taskId: "task-timeout",
      agentId: "agent-timeout",
      toolName: "slow-once",
      input: "Wait too long",
      payload: {}
    };

    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      details: { timeoutMs: 10 }
    });

    // The public deadline has fired, but the original tool invocation is still
    // executing. Keep ownership so a retry cannot overlap its side effects.
    expect(runtime.getInFlightTaskCount()).toBe(1);
    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "DUPLICATE_IN_FLIGHT_TASK"
    });
    expect(calls).toBe(1);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getInFlightTaskCount()).toBe(0);
    await expect(runtime.executeTask(task)).resolves.toMatchObject({
      taskId: "task-timeout",
      output: "retry-result"
    });
    expect(calls).toBe(2);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.taskId).toBe("task-timeout");
    expect(failures[0]?.reason).toContain("timed out after 10ms");
  });

  it("reports a timed-out tool that never settles as stranded during stop", async () => {
    const eventBus = new RuntimeEventBus();
    const stopped: Array<{ strandedTaskIds?: string[] }> = [];

    eventBus.on("runtime.stopped", (event) => {
      stopped.push({ strandedTaskIds: event.payload.strandedTaskIds });
    });

    const runtime = new AgentRuntime({
      runtimeId: "runtime-timeout-drain",
      eventBus,
      maxTaskDurationMs: 5
    });
    runtime.registerTool({
      name: "never-settles",
      description: "Never resolves.",
      execute() {
        return new Promise<never>(() => {});
      }
    });

    await runtime.start();
    await expect(
      runtime.executeTask({
        taskId: "stranded-after-timeout",
        agentId: "agent-timeout",
        toolName: "never-settles",
        input: "Remain active after the response deadline",
        payload: {}
      })
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      details: { timeoutMs: 5 }
    });

    expect(runtime.getInFlightTaskCount()).toBe(1);
    await runtime.stop({ drainTimeoutMs: 5 });

    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.strandedTaskIds).toEqual(["stranded-after-timeout"]);
    expect(runtime.getInFlightTaskCount()).toBe(0);
  });
});
