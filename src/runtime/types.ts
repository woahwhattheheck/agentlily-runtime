import type { RuntimeEventBus } from "../events/runtime-events.js";
import type { RuntimeLogger } from "../logger/runtime-logger.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ToolPolicy } from "../policies/tool-policy.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { RuntimeStateStore } from "../state/runtime-state.js";
import type { TaskClaimStore } from "../tasks/task-claim-store.js";
import type { TaskOutcomeReconciliationAuthority } from "../tasks/task-outcome-reconciliation.js";
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
  /**
   * Safety authority for task IDs that may have an ambiguous side-effect
   * outcome. Supply a durable implementation to preserve the fence across
   * process restarts.
   */
  taskClaimStore?: TaskClaimStore;
  /**
   * File path for the built-in durable task claim authority. When omitted and
   * `memoryStoragePath` selects the built-in file memory store, a sidecar path
   * of `<memoryStoragePath>.task-claims.json` is used automatically.
   */
  taskClaimStoragePath?: string | undefined;
  /**
   * Optional control-plane authority that may release an ambiguous task claim
   * only after proving both that its prior external side effect was not applied
   * and that the prior attempt is quiescent. There is no permissive default.
   */
  taskOutcomeReconciliationAuthority?: TaskOutcomeReconciliationAuthority;
  modelProvider?: ModelProvider;
  logger?: RuntimeLogger;
  stateStore?: RuntimeStateStore;
  eventBus?: RuntimeEventBus;
  tools?: ToolDefinition[];
  /** Optional authorization policy evaluated before each registered tool call. */
  toolPolicy?: ToolPolicy;
}
