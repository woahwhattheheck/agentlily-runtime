import type { RuntimeEventBus } from "../events/runtime-events.js";
import type { RuntimeLogger } from "../logger/runtime-logger.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ToolPolicy } from "../policies/tool-policy.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { RuntimeStateStore } from "../state/runtime-state.js";
import type { ToolDefinition } from "../tools/types.js";

export interface RuntimeOptions {
  runtimeId: string;
  /**
   * Maximum number of agent instances retained by the runtime's
   * AgentInstanceManager. When the cap is reached, the oldest instance is
   * evicted (FIFO) before a new one is created.
   *
   * Defaults to 5_000 when omitted (the AgentInstanceManager default).
   */
  maxAgentInstances?: number;
  maxToolCallsPerTask?: number;
  /** Maximum number of per-task tool-call counters retained by the executor. */
  maxTrackedTasks?: number;
  /** Maximum wall-clock duration for one task execution before rejection. */
  maxTaskDurationMs?: number;
  memoryStore?: MemoryStore;
  memoryStoragePath?: string | undefined;
  modelProvider?: ModelProvider;
  logger?: RuntimeLogger;
  stateStore?: RuntimeStateStore;
  eventBus?: RuntimeEventBus;
  tools?: ToolDefinition[];
  /** Optional authorization policy evaluated before each registered tool call. */
  toolPolicy?: ToolPolicy;
}
