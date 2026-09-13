import type { RuntimeContext } from "../runtime/context.js";

export interface ToolPolicyRequest {
  toolName: string;
  payload: unknown;
  context: RuntimeContext;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolPolicy {
  evaluate(
    request: ToolPolicyRequest
  ):
    | boolean
    | ToolPolicyDecision
    | Promise<boolean | ToolPolicyDecision>;
}

/**
 * Exact-name allowlist policy for runtimes that should expose only a bounded
 * subset of registered tools. An empty allowlist denies every registered tool.
 */
export class ToolAllowlistPolicy implements ToolPolicy {
  private readonly allowedTools: ReadonlySet<string>;

  public constructor(toolNames: Iterable<string>) {
    this.allowedTools = new Set(toolNames);
  }

  public evaluate(request: ToolPolicyRequest): ToolPolicyDecision {
    if (this.allowedTools.has(request.toolName)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Tool "${request.toolName}" is not in the runtime allowlist.`
    };
  }

  public listAllowedTools(): string[] {
    return Array.from(this.allowedTools);
  }
}
