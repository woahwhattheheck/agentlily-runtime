# Runtime- and Payload-Bound Tool Approvals

`ToolApprovalPolicy` adds a one-time human approval boundary for selected runtime tools. It is intended for operations where a static allowlist is not enough: a trusted control plane must approve the **exact invocation** before the runtime can execute it.

An approval is bound to all of the following:

- `runtimeId`
- `taskId`
- `agentId`
- exact `toolName`
- a deterministic, type-aware SHA-256 digest of the exact tool payload

Changing any bound field invalidates the grant. A matching approval is consumed exactly once before the protected tool executes.

## Trust boundary

`approve()` is an authority-bearing operation. Only trusted operator or control-plane code should receive access to the approval store's mutation methods. Do not expose an approval store instance, its `approve()` method, or a durable store writer/file to an untrusted agent or tool.

Both shipped stores are permanently scoped to one `runtimeId` at construction. That namespace is copied into every approval record. `ToolApprovalPolicy` supplies the live `RuntimeContext.runtimeId` on every protected consumption attempt, so reusing a store from a different runtime fails closed without consuming the grant.

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

const approvals = new InMemoryToolApprovalStore({
  runtimeId: "treasury-runtime"
});
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

The first matching invocation in the configured runtime consumes the approval. A retry using the same runtime, task, agent, tool, and payload requires a new explicit approval. Issuing multiple matching grants intentionally authorizes the same number of matching one-time invocations.

A store created for `treasury-runtime` must not be treated as approval authority for another runtime. If the same store is accidentally wired into a different runtime's policy, protected calls are denied and the original approval remains unspent.

## Composition with ordinary tool policy

When `basePolicy` is configured, it is evaluated first. Both authorities must allow a protected invocation:

1. the base policy must allow the tool call;
2. a current matching human approval must exist for the live runtime.

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

Choose the store according to the authority lifetime you need:

- `InMemoryToolApprovalStore` provides atomic one-time consumption inside one JavaScript process. It is appropriate for ephemeral development and tests and intentionally does **not** survive restart or coordinate separate processes.
- `JsonFileToolApprovalStore` persists the runtime-bound approval ledger to one local filesystem and serializes authority-bearing operations across cooperating Node.js processes. It supports durable `approve()`, `revoke()`, `get()`, and one-time `consume()` with atomic publication.

The durable store validates the complete versioned JSON envelope before every operation. Unknown fields, malformed canonical timestamps, invalid payload digests, duplicate approval IDs, mixed runtime identities, unsupported schema versions, and invalid JSON fail closed as `STORAGE_CORRUPTED`.

Mutations use an adjacent atomic create-if-absent lock directory plus a unique temporary file and atomic rename. A crash can strand the lock directory; the store deliberately does not guess that it is stale or break it automatically. Later operations time out with `STORAGE_LOCKED` so an operator can reconcile whether an authority-bearing transition completed.

Current time for grant creation and consumption is sampled **inside** the serialized critical section. Waiting on another process cannot accidentally extend an approval window past its expiry boundary.

Example durable construction:

```ts
import { JsonFileToolApprovalStore } from "@lily-protocol/agentlily-runtime";

const approvals = new JsonFileToolApprovalStore(
  "./data/tool-approvals.json",
  { runtimeId: "treasury-runtime" }
);
```

The durable store is local-filesystem coordination, not a distributed consensus service. Do not place its authority file on a backend whose create/rename semantics do not provide the required local atomicity. The file path and mutation methods are authority-bearing and must remain outside untrusted model/tool surfaces.

## What this does not authorize

A tool approval only authorizes the exact runtime tool invocation under the configured policy. It does not itself establish wallet ownership, provider authentication, payment settlement, legal authority, or successful downstream execution. Those remain separate evidence and control boundaries.
