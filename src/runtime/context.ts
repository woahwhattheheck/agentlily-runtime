import type { AgentInstance } from "../agents/agent-instance-manager.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { RuntimeStateStore } from "../state/runtime-state.js";

export interface RuntimeContext {
  runtimeId: string;
  taskId: string;
  agent: AgentInstance;
  memory: MemoryStore;
  modelProvider: ModelProvider;
  state: RuntimeStateStore;
  now: string;
  /**
   * Cooperative cancellation for the current task. This is provided when the
   * runtime has a configured task timeout so tools can stop pending work before
   * committing a late side effect after the caller has received a timeout.
   */
  abortSignal?: AbortSignal;
}
