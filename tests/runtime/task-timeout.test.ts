import { describe, expect, it } from "vitest";
import { AgentRuntime, RuntimeEventBus } from "../../src/index.js";

describe("AgentRuntime task timeout", () => {
  it("keeps a timed-out task reserved and refuses same-ID retry after settlement", async () => {
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
      description: "Times out after beginning a potentially side-effecting call.",
      execute() {
        calls++;
        return new Promise<string>((resolve) => {
          releaseFirst = () => resolve("late-result");
        });
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

    // Settlement does not prove that a timed-out side effect failed. Keep the
    // task ID retired so the same logical task cannot be executed twice after a
    // false-failure/late-success sequence.
    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "TASK_OUTCOME_UNKNOWN",
      details: { taskId: "task-timeout" }
    });
    expect(calls).toBe(1);

    expect(failures).toHaveLength(2);
    expect(failures[0]?.taskId).toBe("task-timeout");
    expect(failures[0]?.reason).toContain("timed out after 10ms");
    expect(failures[1]?.taskId).toBe("task-timeout");
    expect(failures[1]?.reason).toContain("outcome is unknown");
  });

  it("still allows same-ID retry after an ordinary settled failure", async () => {
    let calls = 0;
    const runtime = new AgentRuntime({
      runtimeId: "runtime-ordinary-failure-retry",
      maxTaskDurationMs: 100
    });
    runtime.registerTool({
      name: "fails-once",
      description: "Fails once before any side effect, then succeeds.",
      execute() {
        calls++;
        if (calls === 1) {
          throw new Error("ordinary failure");
        }
        return "retry-result";
      }
    });

    await runtime.start();

    const task = {
      taskId: "ordinary-failure",
      agentId: "agent-timeout",
      toolName: "fails-once",
      input: "Retry a settled non-timeout failure",
      payload: {}
    };

    await expect(runtime.executeTask(task)).rejects.toThrow("ordinary failure");
    await expect(runtime.executeTask(task)).resolves.toMatchObject({
      taskId: "ordinary-failure",
      output: "retry-result"
    });
    expect(calls).toBe(2);
  });

  it("reports a timed-out tool that never settles as stranded during stop", async () => {
    const eventBus = new RuntimeEventBus();
    const stopped: Array<{ strandedTaskIds: string[] | undefined }> = [];

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
