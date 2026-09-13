import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  RuntimeError,
  TaskRunner,
  ToolRegistry,
  UnconfiguredModelProvider,
  type MemoryStore,
  type RuntimeContext,
  type RuntimeErrorCode,
  type ToolDefinition
} from "../src/index.js";

const createContext = (taskId: string): RuntimeContext => ({
  runtimeId: "runtime-1",
  taskId,
  agent: new AgentInstanceManager().getOrCreate("agent-1"),
  memory: new InMemoryMemoryStore(),
  modelProvider: new UnconfiguredModelProvider(),
  state: new InMemoryRuntimeStateStore(),
  now: new Date().toISOString()
});

const createRunner = (
  tool: ToolDefinition,
  memoryStore: MemoryStore = new InMemoryMemoryStore()
): TaskRunner => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(tool);
  return new TaskRunner(new ActionExecutor(toolRegistry), memoryStore);
};

describe("TaskRunner error propagation", () => {
  it("propagates plain tool errors without changing identity", async () => {
    const failure = new Error("boom");
    const runner = createRunner({
      name: "explode",
      description: "Throws a plain Error",
      execute() {
        throw failure;
      }
    });

    await expect(
      runner.run(
        {
          taskId: "task-plain-error",
          agentId: "agent-1",
          toolName: "explode",
          input: "Trigger a plain tool failure",
          payload: {}
        },
        createContext("task-plain-error")
      )
    ).rejects.toBe(failure);
  });

  it("preserves a tool RuntimeError code, message, details, and identity", async () => {
    const details = {
      reason: "validation_constraint",
      field: "amount",
      value: -50
    };
    const message = "Payment authorization rejected due to invalid parameters";
    const code: RuntimeErrorCode = "MAX_TOOL_CALLS_EXCEEDED";
    const failure = new RuntimeError(code, message, details);
    const runner = createRunner({
      name: "pay",
      description: "Throws a typed RuntimeError",
      execute() {
        throw failure;
      }
    });

    let caught: unknown;
    try {
      await runner.run(
        {
          taskId: "task-runtime-error",
          agentId: "agent-1",
          toolName: "pay",
          input: "Trigger a typed tool failure",
          payload: {}
        },
        createContext("task-runtime-error")
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(caught).toBeInstanceOf(RuntimeError);
    expect(caught).toMatchObject({ code, message, details });
  });

  it("wraps plain memory append failures in EXECUTION_FAILED", async () => {
    const memoryStore: MemoryStore = {
      append: async () => {
        throw new Error("disk unavailable");
      },
      listByAgent: async () => []
    };
    const runner = createRunner(
      {
        name: "ok",
        description: "Returns normally",
        execute: async () => ({ ok: true })
      },
      memoryStore
    );

    await expect(
      runner.run(
        {
          taskId: "task-memory-error",
          agentId: "agent-1",
          toolName: "ok",
          input: "Persist successful output",
          payload: {}
        },
        createContext("task-memory-error")
      )
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "disk unavailable",
      details: { cause: "disk unavailable" }
    });
  });

  it("wraps typed memory append failures instead of leaking their code", async () => {
    const storageFailure = new RuntimeError(
      "TOOL_NOT_FOUND",
      "store rejected append"
    );
    const memoryStore: MemoryStore = {
      append: async () => {
        throw storageFailure;
      },
      listByAgent: async () => []
    };
    const runner = createRunner(
      {
        name: "ok",
        description: "Returns normally",
        execute: async () => ({ ok: true })
      },
      memoryStore
    );

    let caught: unknown;
    try {
      await runner.run(
        {
          taskId: "task-typed-memory-error",
          agentId: "agent-1",
          toolName: "ok",
          input: "Persist successful output",
          payload: {}
        },
        createContext("task-typed-memory-error")
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBe(storageFailure);
    expect(caught).toBeInstanceOf(RuntimeError);
    expect(caught).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "store rejected append",
      details: { cause: "store rejected append" }
    });
  });
});
