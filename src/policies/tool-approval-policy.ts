import { createHash, randomUUID } from "node:crypto";
import type {
  ToolPolicy,
  ToolPolicyDecision,
  ToolPolicyRequest
} from "./tool-policy.js";

export interface ToolApprovalGrantRequest {
  approvalId?: string;
  taskId: string;
  agentId: string;
  toolName: string;
  payload: unknown;
  expiresAt?: string;
}

export interface ToolApprovalRecord {
  approvalId: string;
  taskId: string;
  agentId: string;
  toolName: string;
  payloadDigest: string;
  grantedAt: string;
  expiresAt?: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface ToolApprovalConsumeRequest {
  taskId: string;
  agentId: string;
  toolName: string;
  payload: unknown;
}

export interface ToolApprovalConsumeDecision {
  approved: boolean;
  reason?: string;
  approval?: ToolApprovalRecord;
}

export interface ToolApprovalStore {
  consume(
    request: ToolApprovalConsumeRequest
  ): ToolApprovalConsumeDecision | Promise<ToolApprovalConsumeDecision>;
}

export interface InMemoryToolApprovalStoreOptions {
  now?: () => Date;
}

export interface ToolApprovalPolicyOptions {
  approvalStore: ToolApprovalStore;
  protectedTools: Iterable<string>;
  basePolicy?: ToolPolicy;
}

function requireNonEmpty(label: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseCanonicalInstant(label: string, value: string): number {
  const instant = new Date(value);
  const millis = instant.getTime();
  if (!Number.isFinite(millis) || instant.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 instant.`);
  }
  return millis;
}

function canonicalizePayload(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return `s:${JSON.stringify(value)}`;
    case "boolean":
      return value ? "b:1" : "b:0";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Approval payload numbers must be finite.");
      }
      return `n:${Object.is(value, -0) ? "-0" : value.toString()}`;
    case "bigint":
      return `i:${value.toString()}`;
    case "undefined":
      return "u:";
    case "object":
      break;
    default:
      throw new TypeError(
        `Approval payload contains unsupported value type "${typeof value}".`
      );
  }

  if (seen.has(value)) {
    throw new TypeError("Approval payload must not contain cycles.");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (typeof key === "symbol") {
          throw new TypeError("Approval payload arrays must not contain symbol keys.");
        }
        if (key === "length") {
          continue;
        }
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== key ||
          index >= value.length
        ) {
          throw new TypeError(
            "Approval payload arrays must not contain non-index properties."
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          throw new TypeError(
            "Approval payload arrays must contain enumerable data properties only."
          );
        }
      }

      const parts: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Approval payload arrays must not contain holes.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("Approval payload arrays must contain data values only.");
        }
        parts.push(canonicalizePayload(descriptor.value, seen));
      }
      return `a:[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Approval payload objects must be plain objects.");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Approval payload objects must not contain symbol keys.");
    }

    const stringKeys = ownKeys as string[];
    stringKeys.sort();
    const parts: string[] = [];
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new TypeError(
          "Approval payload objects must contain enumerable data properties only."
        );
      }
      parts.push(
        `${JSON.stringify(key)}:${canonicalizePayload(descriptor.value, seen)}`
      );
    }
    return `o:{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Computes the privacy-safe digest used to bind an approval to the exact
 * JavaScript payload that will reach a tool. Unsupported or ambiguous payload
 * shapes fail closed rather than being partially serialized.
 */
export function digestToolApprovalPayload(payload: unknown): string {
  const canonical = canonicalizePayload(payload, new Set<object>());
  return createHash("sha256")
    .update("agentlily-tool-approval-v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

function cloneRecord(record: ToolApprovalRecord): ToolApprovalRecord {
  return { ...record };
}

/**
 * Single-process approval authority with atomic one-time consumption.
 *
 * This store intentionally does not claim restart or multi-process durability;
 * callers that need those properties can provide another ToolApprovalStore.
 */
export class InMemoryToolApprovalStore implements ToolApprovalStore {
  private readonly approvals = new Map<string, ToolApprovalRecord>();
  private readonly now: () => Date;

  public constructor(options: InMemoryToolApprovalStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public approve(request: ToolApprovalGrantRequest): ToolApprovalRecord {
    const taskId = requireNonEmpty("taskId", request.taskId);
    const agentId = requireNonEmpty("agentId", request.agentId);
    const toolName = requireNonEmpty("toolName", request.toolName);
    const approvalId =
      request.approvalId === undefined
        ? randomUUID()
        : requireNonEmpty("approvalId", request.approvalId);

    if (this.approvals.has(approvalId)) {
      throw new RangeError(`Approval "${approvalId}" already exists.`);
    }

    const now = this.now();
    const grantedAt = now.toISOString();
    let expiresAt: string | undefined;
    if (request.expiresAt !== undefined) {
      const expiresAtMillis = parseCanonicalInstant("expiresAt", request.expiresAt);
      if (expiresAtMillis <= now.getTime()) {
        throw new RangeError("expiresAt must be later than the grant instant.");
      }
      expiresAt = request.expiresAt;
    }

    const record: ToolApprovalRecord = {
      approvalId,
      taskId,
      agentId,
      toolName,
      payloadDigest: digestToolApprovalPayload(request.payload),
      grantedAt,
      ...(expiresAt === undefined ? {} : { expiresAt })
    };
    this.approvals.set(approvalId, record);
    return cloneRecord(record);
  }

  public revoke(approvalId: string): boolean {
    const normalizedId = requireNonEmpty("approvalId", approvalId);
    const current = this.approvals.get(normalizedId);
    if (
      current === undefined ||
      current.consumedAt !== undefined ||
      current.revokedAt !== undefined
    ) {
      return false;
    }

    this.approvals.set(normalizedId, {
      ...current,
      revokedAt: this.now().toISOString()
    });
    return true;
  }

  public get(approvalId: string): ToolApprovalRecord | undefined {
    const record = this.approvals.get(approvalId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  public consume(request: ToolApprovalConsumeRequest): ToolApprovalConsumeDecision {
    let payloadDigest: string;
    try {
      payloadDigest = digestToolApprovalPayload(request.payload);
    } catch {
      return {
        approved: false,
        reason: "Tool payload cannot be deterministically bound to a human approval."
      };
    }

    const now = this.now();
    const nowMillis = now.getTime();
    for (const [approvalId, record] of this.approvals) {
      if (
        record.taskId !== request.taskId ||
        record.agentId !== request.agentId ||
        record.toolName !== request.toolName ||
        record.payloadDigest !== payloadDigest ||
        record.consumedAt !== undefined ||
        record.revokedAt !== undefined
      ) {
        continue;
      }

      if (
        record.expiresAt !== undefined &&
        parseCanonicalInstant("expiresAt", record.expiresAt) <= nowMillis
      ) {
        continue;
      }

      const consumed: ToolApprovalRecord = {
        ...record,
        consumedAt: now.toISOString()
      };
      this.approvals.set(approvalId, consumed);
      return { approved: true, approval: cloneRecord(consumed) };
    }

    return {
      approved: false,
      reason: `Tool "${request.toolName}" requires a current human approval bound to this invocation.`
    };
  }
}

function decisionAllows(decision: boolean | ToolPolicyDecision): boolean {
  return decision === true ||
    (typeof decision === "object" &&
      decision !== null &&
      decision.allowed === true);
}

function resolveAgentId(request: ToolPolicyRequest): string {
  const agent = request.context.agent as { agentId?: string; id?: string };
  return agent.agentId ?? agent.id ?? "";
}

/**
 * Tool policy that requires one payload-bound, one-time human approval for an
 * exact set of protected tool names. An optional base policy is evaluated
 * first; a base denial never consumes an approval.
 */
export class ToolApprovalPolicy implements ToolPolicy {
  private readonly approvalStore: ToolApprovalStore;
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

    const approval = await this.approvalStore.consume({
      taskId: request.context.taskId,
      agentId,
      toolName: request.toolName,
      payload: request.payload
    });

    if (approval.approved) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason:
        approval.reason ??
        `Tool "${request.toolName}" requires a current human approval.`
    };
  }

  public listProtectedTools(): string[] {
    return Array.from(this.protectedTools);
  }
}
