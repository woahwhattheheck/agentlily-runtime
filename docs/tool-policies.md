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

See [Payload-Bound Tool Approvals](./tool-approvals.md) for the trust boundary,
expiry/revocation behavior, payload canonicalization rules, and durability
requirements.

Tool policy and approval policy are execution guards, not a claim that every
external authorization problem is solved. Durable/distributed approval stores,
wallet ownership, provider authentication, settlement evidence, and broader
organizational approval workflows remain separate control boundaries.
