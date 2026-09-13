import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  type MemoryEntry,
  type MemoryStore
} from "../../src/index.js";

describe("AgentRuntime post-tool persistence failure", () => {
  it("retires the failed task ID before a retry can repeat the side effect", async () => {
    const persisted: MemoryEntry[] = [];
    let appendCalls = 0;
    const memoryStore: MemoryStore = {
      async append(entry) {
        appendCalls++;
        if (appendCalls === 1) {
          throw new Error("durable store unavailable");
        }
        persisted.push(entry);
      },
      async listByAgent(agentId) {
        return persisted.filter((entry) => entry.agentId === agentId);
      }
    };

    const sideEffects: string[] = [];
    const runtime = new AgentRuntime({
      runtimeId: "runtime-post-tool-persistence-failure",
      memoryStore,
      maxToolCallsPerTask: 1
    });
    runtime.registerTool({
      name: "side-effect",
      description: "Records one externally visible side effect.",
      execute({ context }) {
        sideEffects.push(context.taskId);
        return { committed: context.taskId };
      }
    });

    await runtime.start();

    const task = {
      taskId: "payment-1",
      agentId: "agent-finance",
      toolName: "side-effect",
      input: "Execute one payment-like side effect",
      payload: {}
    };

    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "durable store unavailable",
      details: { cause: "durable store unavailable" }
    });
    expect(sideEffects).toEqual(["payment-1"]);
    expect(appendCalls).toBe(1);

    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "TASK_OUTCOME_UNKNOWN",
      details: { taskId: "payment-1" }
    });
    expect(sideEffects).toEqual(["payment-1"]);
    expect(appendCalls).toBe(1);

    await expect(
      runtime.executeTask({
        ...task,
        taskId: "payment-2"
      })
    ).resolves.toMatchObject({
      taskId: "payment-2",
      output: { committed: "payment-2" }
    });
    expect(sideEffects).toEqual(["payment-1", "payment-2"]);
    expect(appendCalls).toBe(2);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.taskId).toBe("payment-2");
  });
});
