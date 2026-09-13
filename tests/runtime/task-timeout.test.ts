import { describe, expect, it } from "vitest";
import { AgentRuntime, RuntimeEventBus } from "../../src/index.js";

describe("AgentRuntime task timeout", () => {
  it("fails a hung task, clears in-flight state, and emits runtime.task.failed", async () => {
    const eventBus = new RuntimeEventBus();
    const failures: Array<{ taskId: string; reason: string }> = [];

    eventBus.on("runtime.task.failed", (event) => {
      failures.push({
        taskId: event.payload.taskId,
        reason: event.payload.reason
      });
    });

    const runtime = new AgentRuntime({
      runtimeId: "runtime-task-timeout",
      eventBus,
      maxTaskDurationMs: 10
    });
    runtime.registerTool({
      name: "hang",
      description: "Never resolves.",
      execute() {
        return new Promise<never>(() => {});
      }
    });

    await runtime.start();

    await expect(
      runtime.executeTask({
        taskId: "task-timeout",
        agentId: "agent-timeout",
        toolName: "hang",
        input: "Wait forever",
        payload: {}
      })
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      details: { timeoutMs: 10 }
    });

    expect(runtime.getInFlightTaskCount()).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.taskId).toBe("task-timeout");
    expect(failures[0]?.reason).toContain("timed out after 10ms");
  });

  it("aborts a cooperative tool before a delayed side effect after timeout", async () => {
    let delayedSideEffect = false;
    let observedSignal: AbortSignal | undefined;

    const runtime = new AgentRuntime({
      runtimeId: "runtime-task-timeout-abort",
      maxTaskDurationMs: 10
    });
    runtime.registerTool({
      name: "cooperative-delay",
      description: "Waits before committing a side effect.",
      execute({ context }) {
        observedSignal = context.abortSignal;

        return new Promise<string>((resolve, reject) => {
          const handle = setTimeout(() => {
            delayedSideEffect = true;
            resolve("late side effect");
          }, 50);

          context.abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(handle);
              reject(
                context.abortSignal?.reason instanceof Error
                  ? context.abortSignal.reason
                  : new Error("task aborted")
              );
            },
            { once: true }
          );
        });
      }
    });

    await runtime.start();

    await expect(
      runtime.executeTask({
        taskId: "task-timeout-abort",
        agentId: "agent-timeout-abort",
        toolName: "cooperative-delay",
        input: "Do not commit after timeout",
        payload: {}
      })
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      details: { timeoutMs: 10 }
    });

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(delayedSideEffect).toBe(false);
  });
});
