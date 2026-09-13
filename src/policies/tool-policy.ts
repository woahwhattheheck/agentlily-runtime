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

/**
 * Requires every child policy to allow an invocation. Policies are evaluated
 * in order and the first denial is returned unchanged. The iterable is
 * snapshotted at construction time so later array mutation cannot add or
 * remove authorization gates.
 *
 * Composition does not roll back side effects from policies that already
 * returned allow. Put one-shot or consuming policies last (for example, use
 * this composer as ToolApprovalPolicy's basePolicy rather than placing a
 * consuming ToolApprovalPolicy before later guards).
 */
export class AllOfToolPolicy implements ToolPolicy {
  private readonly policies: readonly ToolPolicy[];

  public constructor(policies: Iterable<ToolPolicy>) {
    this.policies = Array.from(policies);
    if (this.policies.length === 0) {
      throw new RangeError("AllOfToolPolicy requires at least one policy.");
    }
  }

  public async evaluate(
    request: ToolPolicyRequest
  ): Promise<boolean | ToolPolicyDecision> {
    for (const policy of this.policies) {
      const decision = await policy.evaluate(request);
      if (
        decision === true ||
        (typeof decision === "object" &&
          decision !== null &&
          decision.allowed === true)
      ) {
        continue;
      }
      return decision;
    }

    return { allowed: true };
  }
}
