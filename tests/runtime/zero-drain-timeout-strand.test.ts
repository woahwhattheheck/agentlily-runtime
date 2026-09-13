import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";

describe("AgentRuntime.stop with zero drain timeout", () => {
  it("reports active tasks as stranded for an explicit zero timeout", async () => {
    const warn = vi.fn();
    const runtime = new AgentRuntime({
      runtimeId: "rt-zero-drain-strand",
      logger: {
        level: "debug",
        info: vi.fn(),
        warn,
        error: vi.fn(),
        debug: vi.fn()
      }
    });

    let releaseTool!: () => void;
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });

    runtime.registerTool({
      name: "blocked-tool",
      description: "Waits until the test releases it.",
      execute: async () => {
        markToolStarted();
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        return { ok: true };
      }
    });

    const stoppedPayloads: Array<{
      strandedTaskIds?: string[];
      drainDurationMs?: number;
    }> = [];
    runtime.getDependencies().eventBus.on("runtime.stopped", (event) => {
      stoppedPayloads.push(event.payload);
    });

    await runtime.start();
    const taskPromise = runtime.executeTask({
      taskId: "zero-timeout-task",
      agentId: "agent-zero-timeout",
      toolName: "blocked-tool",
      input: "block until shutdown",
      payload: {}
    });

    await toolStarted;
    expect(runtime.getInFlightTaskCount()).toBe(1);

    await runtime.stop({ drainTimeoutMs: 0 });

    expect(runtime.getInFlightTaskCount()).toBe(0);
    expect(stoppedPayloads).toHaveLength(1);
    expect(stoppedPayloads[0]?.strandedTaskIds).toEqual([
      "zero-timeout-task"
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("zero-timeout-task"),
      expect.objectContaining({
        drainTimeoutMs: 0,
        strandedTaskIds: ["zero-timeout-task"]
      })
    );

    releaseTool();
    await expect(taskPromise).resolves.toMatchObject({ output: { ok: true } });
  });
});
