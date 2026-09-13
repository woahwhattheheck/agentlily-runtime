import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  type MemoryEntry,
  type MemoryStore,
  type TaskOutcomeStore
} from "../../src/index.js";

const tempDirectories: string[] = [];

const makeTempPath = async (name: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentlily-task-outcome-"));
  tempDirectories.push(directory);
  return join(directory, name);
};

const collectingMemoryStore = (entries: MemoryEntry[] = []): MemoryStore => ({
  async append(entry) {
    entries.push(entry);
  },
  async listByAgent(agentId) {
    return entries.filter((entry) => entry.agentId === agentId);
  }
});

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("restart-safe task outcome authority", () => {
  it("refuses a same-ID retry after reconstruction when result persistence failed", async () => {
    const outcomePath = await makeTempPath("outcomes.json");
    const sideEffects: string[] = [];
    const failingMemoryStore: MemoryStore = {
      async append() {
        throw new Error("result store unavailable");
      },
      async listByAgent() {
        return [];
      }
    };

    const createRuntime = (runtimeId: string, memoryStore: MemoryStore) => {
      const runtime = new AgentRuntime({
        runtimeId,
        memoryStore,
        taskOutcomeStoragePath: outcomePath,
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
      return runtime;
    };

    const task = {
      taskId: "payment-restart-1",
      agentId: "agent-finance",
      toolName: "side-effect",
      input: "Execute one payment-like side effect",
      payload: {}
    };

    const first = createRuntime("runtime-before-restart", failingMemoryStore);
    await first.start();
    await expect(first.executeTask(task)).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "result store unavailable"
    });
    expect(sideEffects).toEqual(["payment-restart-1"]);
    await first.stop();

    const recoveredEntries: MemoryEntry[] = [];
    const second = createRuntime(
      "runtime-after-restart",
      collectingMemoryStore(recoveredEntries)
    );
    await second.start();
    await expect(second.executeTask(task)).rejects.toMatchObject({
      code: "TASK_OUTCOME_UNKNOWN",
      details: { taskId: "payment-restart-1" }
    });
    expect(sideEffects).toEqual(["payment-restart-1"]);
    expect(recoveredEntries).toEqual([]);
    await second.stop();
  });

  it("fails closed before tool execution when durable intent cannot be written", async () => {
    let toolCalls = 0;
    let memoryAppends = 0;
    const outcomeStore: TaskOutcomeStore = {
      async begin() {
        throw new Error("outcome journal unavailable");
      },
      async complete() {
        throw new Error("unexpected completion");
      }
    };
    const memoryStore: MemoryStore = {
      async append() {
        memoryAppends++;
      },
      async listByAgent() {
        return [];
      }
    };
    const runtime = new AgentRuntime({
      runtimeId: "runtime-intent-fail-closed",
      memoryStore,
      taskOutcomeStore,
      maxToolCallsPerTask: 1
    });
    runtime.registerTool({
      name: "side-effect",
      description: "Must not run without a durable task intent.",
      execute() {
        toolCalls++;
        return { committed: true };
      }
    });
    await runtime.start();

    await expect(
      runtime.executeTask({
        taskId: "payment-intent-unavailable",
        agentId: "agent-finance",
        toolName: "side-effect",
        input: "Do not execute without durable intent",
        payload: {}
      })
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "outcome journal unavailable",
      details: { cause: "outcome journal unavailable" }
    });
    expect(toolCalls).toBe(0);
    expect(memoryAppends).toBe(0);
    await runtime.stop();
  });

  it("keeps completed task IDs reusable across runtime reconstruction", async () => {
    const outcomePath = await makeTempPath("reusable-outcomes.json");
    const sideEffects: string[] = [];
    const task = {
      taskId: "reusable-task-id",
      agentId: "agent-worker",
      toolName: "repeatable-tool",
      input: "Run one completed invocation",
      payload: {}
    };

    const createRuntime = (runtimeId: string) => {
      const runtime = new AgentRuntime({
        runtimeId,
        memoryStore: collectingMemoryStore(),
        taskOutcomeStoragePath: outcomePath,
        maxToolCallsPerTask: 1
      });
      runtime.registerTool({
        name: "repeatable-tool",
        description: "A successfully completed task may be reused later.",
        execute({ context }) {
          sideEffects.push(context.taskId);
          return { invocation: sideEffects.length };
        }
      });
      return runtime;
    };

    const first = createRuntime("runtime-reuse-first");
    await first.start();
    await expect(first.executeTask(task)).resolves.toMatchObject({
      taskId: "reusable-task-id",
      output: { invocation: 1 }
    });
    await first.stop();

    const second = createRuntime("runtime-reuse-second");
    await second.start();
    await expect(second.executeTask(task)).resolves.toMatchObject({
      taskId: "reusable-task-id",
      output: { invocation: 2 }
    });
    expect(sideEffects).toEqual(["reusable-task-id", "reusable-task-id"]);
    await second.stop();
  });
});
