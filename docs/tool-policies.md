# Runtime Tool Policies

`agentlily-runtime` can authorize each registered tool immediately before the
runtime consumes tool-call budget or emits `runtime.tool.invoked`.

When no `toolPolicy` is configured, behavior is unchanged: every registered
tool is eligible to execute subject to the runtime's existing guards.

## Static allowlist

Use `ToolAllowlistPolicy` when a runtime should expose only a known subset of
its registered tools:

```ts
import {
  AgentRuntime,
  ToolAllowlistPolicy
} from "@lily-protocol/agentlily-runtime";

const runtime = new AgentRuntime({
  runtimeId: "read-only-agent",
  toolPolicy: new ToolAllowlistPolicy([
    "account.read",
    "wallet.prepare_payment"
  ])
});
```

The allowlist uses exact tool names. An empty allowlist denies every registered
tool.

## Compose independent guards

`AllOfToolPolicy` requires every child policy to allow an invocation. Policies
run in order and the first denial is preserved, so a controller can keep
coarse tool exposure separate from domain-specific authorization:

```ts
import {
  AllOfToolPolicy,
  ToolAllowlistPolicy
} from "@lily-protocol/agentlily-runtime";

const policy = new AllOfToolPolicy([
  new ToolAllowlistPolicy(["account.read", "wallet.prepare_payment"]),
  domainPolicy
]);
```

The child-policy iterable is snapshotted at construction time. An empty
`AllOfToolPolicy` is rejected rather than silently becoming allow-all.

Composition short-circuits on the first denial, but it cannot roll back side
effects from a policy that already returned allow. Put one-shot or consuming
policies last. In particular, when human approval is required, prefer passing
an `AllOfToolPolicy` as `ToolApprovalPolicy.basePolicy` so all non-consuming
guards run before the approval grant is consumed.

## Constrain Stellar payment intents

Allowing the `wallet.prepare_payment` tool by name does not by itself constrain
which payment intent an agent may prepare. `StellarPaymentIntentPolicy` adds a
controller-owned, per-wallet fence around the existing simulated payment prep
tool.

```ts
import {
  AllOfToolPolicy,
  StellarPaymentIntentPolicy,
  ToolAllowlistPolicy
} from "@lily-protocol/agentlily-runtime";

const policy = new AllOfToolPolicy([
  new ToolAllowlistPolicy(["wallet.prepare_payment"]),
  new StellarPaymentIntentPolicy({
    wallets: [
      {
        walletId: "treasury",
        maxAmount: "25.0000000",
        allowedRecipientIds: ["approved-merchant"],
        allowedAssets: [{ assetCode: "XLM" }],
        requireRecipient: true,
        requireMemo: true
      }
    ]
  })
]);

const runtime = new AgentRuntime({
  runtimeId: "bounded-treasury-agent",
  toolPolicy: policy
});
```

Payment rules are exact and opt-in:

- an unconfigured wallet is denied;
- `maxAmount` is configured as a decimal string and compared in integer
  stroops, so authorization never depends on binary floating-point rounding;
- an `allowedRecipientIds` iterable, when provided, requires an explicit exact
  recipient match;
- an `allowedAssets` iterable, when provided, requires an exact asset identity:
  native XLM has no issuer, while issued assets include both code and issuer;
- `requireRecipient` and `requireMemo` can enforce explicit routing/audit
  fields;
- mutable rule iterables are copied during construction, so later caller
  mutation cannot relax a live policy;
- accessor-backed and Proxy payment payloads are rejected before their values
  are evaluated by the policy;
- an allowed payment intent is rebound to the original top-level data fields
  and that payload object is frozen before policy returns, preventing an
  approved intent from being swapped during the executor's authorization gap.

Before applying its own rules, the payment policy validates a sanitized payload
through the existing `wallet.prepare_payment` implementation. Invalid Stellar
amounts, issuers, and memos therefore fail closed without copying arbitrary
payload diagnostics into the policy denial reason.

The payment policy passes non-payment tools through. Pair it with
`ToolAllowlistPolicy` (or another coarse authorization policy) when the runtime
must also constrain which tool names are callable.

This guard authorizes **simulated payment preparation only**. It does not sign,
approve, submit, broadcast, settle, or otherwise execute a Stellar transaction.

## Dynamic policy

A custom policy receives the tool name, payload, and full `RuntimeContext`, so
it can make per-task or per-agent decisions. Policies may be synchronous or
asynchronous and may return either a boolean or `{ allowed, reason }`.

```ts
import type { ToolPolicy } from "@lily-protocol/agentlily-runtime";

const policy: ToolPolicy = {
  async evaluate({ toolName, payload, context }) {
    if (context.agent.agentId !== "treasury-agent") {
      return { allowed: false, reason: "Agent is not authorized." };
    }

    return {
      allowed: toolName === "wallet.prepare_payment",
      reason: "Only payment preparation is allowed for this runtime."
    };
  }
};
```

## Denial behavior

Authorization is fail-closed:

- an explicit `false` or `{ allowed: false }` denies the invocation;
- a policy exception also denies the invocation;
- denied tools are never executed;
- denied calls do not consume the per-task tool-call budget;
- denied calls do not emit `runtime.tool.invoked`;
- a denial emits `runtime.tool.denied` with the runtime, task, agent, tool,
  reason, and denial timestamp;
- the caller receives a `RuntimeError` with code `TOOL_POLICY_DENIED`.

Tool lookup happens before policy evaluation, so an unknown name still reports
`TOOL_NOT_FOUND` rather than leaking into policy handling.

## Human approval for selected tools

For one-time, payload-bound human approval, compose ordinary tool policy with
`ToolApprovalPolicy`. It binds an approval to the exact task, agent, tool, and
type-aware payload digest, then consumes that grant once before execution.

If the base authorization has multiple independent guards, compose those guards
with `AllOfToolPolicy` and pass that composer as `ToolApprovalPolicy.basePolicy`.
That ordering ensures a base denial never consumes the one-time approval.

See [Payload-Bound Tool Approvals](./tool-approvals.md) for the trust boundary,
expiry/revocation behavior, payload canonicalization rules, and durability
requirements.

Tool policy and approval policy are execution guards, not a claim that every
external authorization problem is solved. Durable/distributed approval stores,
wallet ownership, provider authentication, settlement evidence, and broader
organizational approval workflows remain separate control boundaries.
