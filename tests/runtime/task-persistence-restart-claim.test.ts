import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  InMemoryMemoryStore,
  JsonFileTaskClaimStore,
  createRuntimeDependencies,
  type MemoryEntry,
  type MemoryStore
} from "../../src/index.js";

const task = {
  taskId: "payment-1",
  agentId: "agent-finance",
  toolName: "side-effect",
  input: "Execute one payment-like side effect",
  payload: {}
};

describe("durable task claims", () => {
  it("blocks same-ID re-execution after post-tool persistence failure and runtime recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentlily-task-claim-"));
    const claimPath = join(dir, "task-claims.json");
    const sideEffects: string[] = [];

    const failingMemoryStore: MemoryStore = {
      async append() {
        throw new Error("durable store unavailable");
      },
      async listByAgent() {
        return [];
      }
    };

    const registerSideEffect = (runtime: AgentRuntime): void => {
      runtime.registerTool({
        name: "side-effect",
        description: "Records one externally visible side effect.",
        execute({ context }) {
          sideEffects.push(context.taskId);
          return { committed: context.taskId };
        }
      });
    };

    try {
      const firstRuntime = new AgentRuntime({
        runtimeId: "runtime-before-restart",
        memoryStore: failingMemoryStore,
        taskClaimStoragePath: claimPath,
        maxToolCallsPerTask: 1
      });
      registerSideEffect(firstRuntime);
      await firstRuntime.start();

      await expect(firstRuntime.executeTask(task)).rejects.toMatchObject({
        code: "EXECUTION_FAILED",
        message: "durable store unavailable"
      });
      expect(sideEffects).toEqual(["payment-1"]);
      await firstRuntime.stop();

      const recoveredMemoryStore = new InMemoryMemoryStore();
      const restartedRuntime = new AgentRuntime({
        runtimeId: "runtime-after-restart",
        memoryStore: recoveredMemoryStore,
        taskClaimStoragePath: claimPath,
        maxToolCallsPerTask: 1
      });
      registerSideEffect(restartedRuntime);
      await restartedRuntime.start();

      await expect(restartedRuntime.executeTask(task)).rejects.toMatchObject({
        code: "TASK_OUTCOME_UNKNOWN",
        details: { taskId: "payment-1" }
      });
      expect(sideEffects).toEqual(["payment-1"]);

      await expect(
        restartedRuntime.executeTask({ ...task, taskId: "payment-2" })
      ).resolves.toMatchObject({
        taskId: "payment-2",
        output: { committed: "payment-2" }
      });
      expect(sideEffects).toEqual(["payment-1", "payment-2"]);

      const persisted: MemoryEntry[] = await recoveredMemoryStore.listByAgent(
        "agent-finance"
      );
      expect(persisted.map((entry) => entry.taskId)).toEqual(["payment-2"]);
      await restartedRuntime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists claims across store instances and releases known outcomes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentlily-claim-store-"));
    const claimPath = join(dir, "claims.json");

    try {
      const first = new JsonFileTaskClaimStore(claimPath);
      expect(await first.claim("task-1")).toBe(true);

      const restarted = new JsonFileTaskClaimStore(claimPath);
      expect(await restarted.claim("task-1")).toBe(false);
      expect(await restarted.has("task-1")).toBe(true);

      await restarted.release("task-1");
      expect(await first.has("task-1")).toBe(false);
      expect(await first.claim("task-1")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("derives a durable claim sidecar from built-in file memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentlily-claim-sidecar-"));
    const memoryPath = join(dir, "memory.json");

    try {
      const dependencies = createRuntimeDependencies({
        runtimeId: "runtime-sidecar",
        memoryStoragePath: memoryPath
      });

      expect(dependencies.taskClaimStore).toBeInstanceOf(JsonFileTaskClaimStore);
      expect(
        (dependencies.taskClaimStore as JsonFileTaskClaimStore).getFilePath()
      ).toBe(`${memoryPath}.task-claims.json`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
