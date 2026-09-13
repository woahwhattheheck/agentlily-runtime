import { types as utilTypes } from "node:util";
import {
  digestToolApprovalPayload as digestLegacyToolApprovalPayload,
  type ToolApprovalPolicyOptions
} from "./tool-approval-policy.js";
import type {
  ToolPolicy,
  ToolPolicyDecision,
  ToolPolicyRequest
} from "./tool-policy.js";

function requireNonEmpty(label: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function decisionAllows(decision: boolean | ToolPolicyDecision): boolean {
  return (
    decision === true ||
    (typeof decision === "object" &&
      decision !== null &&
      decision.allowed === true)
  );
}

function resolveAgentId(request: ToolPolicyRequest): string {
  const agent = request.context.agent as { agentId?: string; id?: string };
  return agent.agentId ?? agent.id ?? "";
}

function rejectProxyTree(value: unknown, visited: Set<object>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (utilTypes.isProxy(value)) {
    throw new TypeError("Approval payload must not contain Proxy objects.");
  }
  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      rejectProxyTree(descriptor.value, visited);
    }
  }
}

/**
 * Public payload digest with Proxy rejection before any user traps can run.
 * Ordinary supported values retain the exact legacy digest bytes.
 */
export function digestToolApprovalPayload(payload: unknown): string {
  rejectProxyTree(payload, new Set<object>());
  return digestLegacyToolApprovalPayload(payload);
}

function freezeApprovedPayload(value: unknown, visited: Set<object>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (utilTypes.isProxy(value)) {
    throw new TypeError("Approval payload must not contain Proxy objects.");
  }
  if (visited.has(value)) {
    throw new TypeError(
      "Approval payload must not contain cycles or shared references."
    );
  }
  visited.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        "Approval payload must contain data properties only before execution."
      );
    }
    freezeApprovedPayload(descriptor.value, visited);
  }
  Object.freeze(value);
}

function payloadChangedDecision(): ToolPolicyDecision {
  return {
    allowed: false,
    reason: "Protected tool payload changed during approval evaluation."
  };
}

/**
 * Public protected-tool policy with an execution handoff seal.
 *
 * The approval backend consumes authority against one exact payload digest.
 * This policy rechecks the same object after every awaited approval lookup and
 * recursively freezes it before returning allow, so the executor cannot later
 * observe a different mutable payload under already-consumed authority.
 */
export class ToolApprovalPolicy implements ToolPolicy {
  private readonly approvalStore: ToolApprovalPolicyOptions["approvalStore"];
  private readonly protectedTools: ReadonlySet<string>;
  private readonly basePolicy: ToolPolicy | undefined;

  public constructor(options: ToolApprovalPolicyOptions) {
    this.approvalStore = options.approvalStore;
    this.basePolicy = options.basePolicy;

    const protectedTools = new Set<string>();
    for (const toolName of options.protectedTools) {
      protectedTools.add(requireNonEmpty("protected tool name", toolName));
    }
    this.protectedTools = protectedTools;
  }

  public async evaluate(
    request: ToolPolicyRequest
  ): Promise<boolean | ToolPolicyDecision> {
    if (this.basePolicy !== undefined) {
      const baseDecision = await this.basePolicy.evaluate(request);
      if (!decisionAllows(baseDecision)) {
        if (baseDecision === false) {
          return false;
        }
        if (
          typeof baseDecision === "object" &&
          baseDecision !== null &&
          baseDecision.allowed === false
        ) {
          return baseDecision;
        }
        return {
          allowed: false,
          reason: "The composed runtime tool policy denied this invocation."
        };
      }
    }

    if (!this.protectedTools.has(request.toolName)) {
      return true;
    }

    const agentId = resolveAgentId(request);
    if (agentId.length === 0) {
      return {
        allowed: false,
        reason: "Protected tool invocation is missing an agent identity."
      };
    }

    let preConsumeDigest: string;
    try {
      preConsumeDigest = digestToolApprovalPayload(request.payload);
    } catch {
      return {
        allowed: false,
        reason:
          "Protected tool payload cannot be deterministically bound to human approval."
      };
    }

    const approval = await this.approvalStore.consume({
      runtimeId: request.context.runtimeId,
      taskId: request.context.taskId,
      agentId,
      toolName: request.toolName,
      payload: request.payload
    });

    if (!approval.approved) {
      return {
        allowed: false,
        reason:
          approval.reason ??
          `Tool "${request.toolName}" requires a current human approval.`
      };
    }

    let postConsumeDigest: string;
    try {
      postConsumeDigest = digestToolApprovalPayload(request.payload);
    } catch {
      return payloadChangedDecision();
    }
    if (postConsumeDigest !== preConsumeDigest) {
      return payloadChangedDecision();
    }
    if (
      approval.approval !== undefined &&
      approval.approval.payloadDigest !== postConsumeDigest
    ) {
      return {
        allowed: false,
        reason: "Human approval authority returned a mismatched payload binding."
      };
    }

    try {
      freezeApprovedPayload(request.payload, new Set<object>());
      if (digestToolApprovalPayload(request.payload) !== postConsumeDigest) {
        return payloadChangedDecision();
      }
    } catch {
      return {
        allowed: false,
        reason: "Protected tool payload could not be sealed for execution."
      };
    }

    return { allowed: true };
  }

  public listProtectedTools(): string[] {
    return Array.from(this.protectedTools);
  }
}
