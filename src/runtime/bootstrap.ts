import { AgentInstanceManager } from "../agents/agent-instance-manager.js";
import { ActionExecutor } from "../actions/action-executor.js";
import { RuntimeEventBus } from "../events/runtime-events.js";
import { ConsoleRuntimeLogger } from "../logger/runtime-logger.js";
import {
  InMemoryMemoryStore,
  JsonFileMemoryStore
} from "../memory/memory-store.js";
import { UnconfiguredModelProvider } from "../providers/model-provider.js";
import { InMemoryRuntimeStateStore } from "../state/runtime-state.js";
import {
  InMemoryTaskOutcomeStore,
  JsonFileTaskOutcomeStore
} from "../tasks/task-outcome-store.js";
import { TaskRunner } from "../tasks/task-runner.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { RuntimeOptions } from "./types.js";

export function createRuntimeDependencies(options: RuntimeOptions) {
  if (typeof options.runtimeId !== "string" || options.runtimeId.trim().length === 0) {
    throw new TypeError("runtimeId must be a non-empty string.");
  }

  if (
    options.memoryStore === undefined &&
    options.memoryStoragePath !== undefined &&
    (typeof options.memoryStoragePath !== "string" ||
      options.memoryStoragePath.trim().length === 0)
  ) {
    throw new TypeError("memoryStoragePath must be a non-empty string.");
  }

  if (
    options.taskOutcomeStore === undefined &&
    options.taskOutcomeStoragePath !== undefined &&
    (typeof options.taskOutcomeStoragePath !== "string" ||
      options.taskOutcomeStoragePath.trim().length === 0)
  ) {
    throw new TypeError("taskOutcomeStoragePath must be a non-empty string.");
  }

  const toolRegistry = new ToolRegistry();
  if (options.tools !== undefined) {
    for (const tool of options.tools) {
      toolRegistry.register(tool);
    }
  }

  const memoryStore =
    options.memoryStore ??
    (options.memoryStoragePath !== undefined
      ? new JsonFileMemoryStore(options.memoryStoragePath)
      : new InMemoryMemoryStore());
  const taskOutcomeStore =
    options.taskOutcomeStore ??
    (options.taskOutcomeStoragePath !== undefined
      ? new JsonFileTaskOutcomeStore(options.taskOutcomeStoragePath)
      : options.memoryStoragePath !== undefined
        ? new JsonFileTaskOutcomeStore(
            `${options.memoryStoragePath}.task-outcomes.json`
          )
        : new InMemoryTaskOutcomeStore());
  const logger = options.logger ?? new ConsoleRuntimeLogger();
  const modelProvider =
    options.modelProvider ?? new UnconfiguredModelProvider(logger);
  const stateStore = options.stateStore ?? new InMemoryRuntimeStateStore();
  const eventBus = options.eventBus ?? new RuntimeEventBus();
  const agentManager = new AgentInstanceManager(
    options.maxAgentInstances !== undefined
      ? { maxInstances: options.maxAgentInstances }
      : {}
  );
  const actionExecutor = new ActionExecutor(
    toolRegistry,
    options.maxToolCallsPerTask,
    eventBus,
    logger,
    options.maxTrackedTasks,
    options.toolPolicy
  );
  const taskRunner = new TaskRunner(
    actionExecutor,
    memoryStore,
    options.maxTaskDurationMs,
    taskOutcomeStore
  );

  return {
    actionExecutor,
    agentManager,
    eventBus,
    logger,
    memoryStore,
    modelProvider,
    stateStore,
    taskOutcomeStore,
    taskRunner,
    toolRegistry
  };
}
