/**
 * AgentRuntime.executeTask() and TaskRunner.run() capture these fields
 * synchronously when called. Reassigning the caller's task fields afterward
 * cannot retarget an accepted execution or its recorded result. The payload
 * value is retained by reference; nested payload objects are not deep-cloned.
 */
export interface RuntimeTask<TPayload = Record<string, unknown>> {
  taskId: string;
  agentId: string;
  toolName: string;
  input: string;
  payload: TPayload;
}

export interface TaskExecutionResult<TResult = unknown> {
  taskId: string;
  agentId: string;
  toolName: string;
  output: TResult;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
