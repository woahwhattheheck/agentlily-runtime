# Payload-Bound Tool Approvals

`ToolApprovalPolicy` adds a one-time human approval boundary for selected runtime tools. It is intended for operations where a static allowlist is not enough: a trusted control plane must approve the **exact invocation** before the runtime can execute it.

An approval is bound to all of the following:

- `taskId`
- `agentId`
- exact `toolName`
- a deterministic, type-aware SHA-256 digest of the exact tool payload

Changing any bound field invalidates the grant. A matching approval is consumed exactly once before the protected tool executes.

## Trust boundary

`approve()` is an authority-bearing operation. Only trusted operator or control-plane code should receive access to the approval store's mutation methods. Do not expose an `InMemoryToolApprovalStore` instance, its `approve()` method, or an equivalent durable store writer to an untrusted agent or tool.

Approval records retain the payload digest, not a copy of the payload. They therefore provide invocation binding without turning the approval ledger into a second payload store.

## Example

The runtime already ships `wallet.prepare_payment`, which is simulated and does not submit a live Stellar transaction. It is used here only as a concrete protected-tool example.

```ts
import {
  AgentRuntime,
  InMemoryToolApprovalStore,
  ToolAllowlistPolicy,
  ToolApprovalPolicy,
  createPaymentPrepTool
} from "@lily-protocol/agentlily-runtime";

const approvals = new InMemoryToolApprovalStore();
const toolPolicy = new ToolApprovalPolicy({
  approvalStore: approvals,
  protectedTools: ["wallet.prepare_payment"],
  basePolicy: new ToolAllowlistPolicy(["wallet.prepare_payment"])
});

const runtime = new AgentRuntime({
  runtimeId: "treasury-runtime",
  toolPolicy
});
runtime.registerTool(createPaymentPrepTool());
await runtime.start();

const payload = {
  walletId: "wallet_treasury",
  amount: "25.00",
  assetCode: "XLM",
  memo: "reviewed payment preparation"
};

// This call belongs in trusted operator/control-plane code after human review.
approvals.approve({
  taskId: "pay-042",
  agentId: "treasury-agent",
  toolName: "wallet.prepare_payment",
  payload,
  expiresAt: "2026-09-13T18:00:00.000Z"
});

const result = await runtime.executeTask({
  agentId: "treasury-agent",
  taskId: "pay-042",
  toolName: "wallet.prepare_payment",
  input: "Prepare the reviewed payment",
  payload
});
```

The first matching invocation consumes the approval. A retry using the same task, agent, tool, and payload requires a new explicit approval. Issuing multiple matching grants intentionally authorizes the same number of matching one-time invocations.

## Composition with ordinary tool policy

When `basePolicy` is configured, it is evaluated first. Both authorities must allow a protected invocation:

1. the base policy must allow the tool call;
2. a current matching human approval must exist.

A base-policy denial does **not** consume an approval. If the base policy throws, the exception reaches the existing `ActionExecutor` policy boundary, which fails closed and emits the ordinary sanitized policy-denial behavior.

Tools outside `protectedTools` still pass through the base policy but do not require a human approval.

## Payload binding

`digestToolApprovalPayload()` uses a deterministic, type-aware representation instead of `JSON.stringify()`. This prevents values that JavaScript or JSON can blur together from sharing approval authority.

Supported values are:

- `null`
- strings
- booleans
- finite numbers, including a distinction between `0` and `-0`
- `bigint`
- `undefined`
- dense arrays
- plain objects with enumerable data properties and string keys

Object key order does not affect the digest. Runtime type does: for example, numeric `1`, string `"1"`, and bigint `1n` have different digests.

The supported object/array shape is an acyclic tree. Shared object or array references are rejected even when they do not form a cycle, because JavaScript tools can observe alias identity (`payload.left === payload.right`) and that distinction must not collapse into the same approval digest.

The approval boundary fails closed for ambiguous or effectful payload shapes, including:

- `NaN` or infinities
- cyclic graphs
- shared object or array references
- sparse arrays or arrays with extra properties
- getters, setters, or other accessors
- symbol-keyed properties
- custom-prototype objects such as `Date`, class instances, `Map`, or `Set`
- functions and symbols as values

Normalize application-specific payloads into plain data before requesting approval rather than weakening this boundary.

## Expiry and revocation

`expiresAt` is optional. When supplied, it must be a canonical UTC ISO-8601 instant such as `2026-09-13T18:00:00.000Z` and must be later than the grant instant. An approval is invalid at or after its expiry instant.

`revoke(approvalId)` invalidates an unused approval. Consumed or already-revoked approvals cannot be revoked again.

## Durability and concurrency

`InMemoryToolApprovalStore` provides atomic one-time consumption inside one JavaScript process. It intentionally does **not** claim restart durability or cross-process atomicity.

Production systems that need durable or distributed approval authority should implement `ToolApprovalStore` with storage that provides atomic compare-and-consume semantics. The policy consumes through that interface, so the execution boundary does not need to change when the backing authority becomes durable.

## What this does not authorize

A tool approval only authorizes the exact runtime tool invocation under the configured policy. It does not itself establish wallet ownership, provider authentication, payment settlement, legal authority, or successful downstream execution. Those remain separate evidence and control boundaries.
