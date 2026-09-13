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
  InMemoryTaskClaimStore,
  JsonFileTaskClaimStore
} from "../tasks/task-claim-store.js";
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
    options.taskClaimStore === undefined &&
    options.taskClaimStoragePath !== undefined &&
    (typeof options.taskClaimStoragePath !== "string" ||
      options.taskClaimStoragePath.trim().length === 0)
  ) {
    throw new TypeError("taskClaimStoragePath must be a non-empty string.");
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

  const taskClaimStore =
    options.taskClaimStore ??
    (options.taskClaimStoragePath !== undefined
      ? new JsonFileTaskClaimStore(options.taskClaimStoragePath)
      : options.memoryStore === undefined && options.memoryStoragePath !== undefined
        ? new JsonFileTaskClaimStore(
            `${options.memoryStoragePath}.task-claims.json`
          )
        : new InMemoryTaskClaimStore());

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
    taskClaimStore
  );

  return {
    actionExecutor,
    agentManager,
    eventBus,
    logger,
    memoryStore,
    modelProvider,
    stateStore,
    taskClaimStore,
    taskRunner,
    toolRegistry
  };
}
