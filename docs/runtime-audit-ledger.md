# Runtime audit ledger

`JsonlRuntimeAuditLedger` turns the existing `RuntimeEventBus` lifecycle stream into a durable, hash-chained JSONL evidence file for operator review and offline integrity checks.

## What it records

Each line is canonical JSON containing the exact runtime event name and its typed event payload, a monotonic sequence number, the prior record digest, and the current SHA-256 record digest. The writer calls `fsync` before advancing its in-memory chain head. A restart verifies the complete existing chain before any append is allowed.

The helper deliberately records runtime events, not task or tool input payloads. Some existing event fields such as failure or policy-denial reasons can still contain application-generated text, so the ledger must be stored and retained as operationally sensitive data.

## Example

```ts
import {
  AgentRuntime,
  JsonlRuntimeAuditLedger,
  RuntimeEventBus,
  attachRuntimeAuditLedger,
  verifyRuntimeAuditLedger
} from "@lily-protocol/agentlily-runtime";

const eventBus = new RuntimeEventBus();
const runtime = new AgentRuntime({ runtimeId: "treasury-agent", eventBus });
const ledger = new JsonlRuntimeAuditLedger("./data/runtime-audit.jsonl", {
  createParentDirectories: true
});
const detachAudit = attachRuntimeAuditLedger(eventBus, ledger);

await runtime.start();
// ... execute tasks ...
await runtime.stop();

detachAudit();
ledger.close();

const verification = verifyRuntimeAuditLedger("./data/runtime-audit.jsonl");
if (!verification.ok) {
  throw new Error(`audit verification failed: ${verification.reason}`);
}
console.log(verification.recordCount, verification.headDigest);
```

`AgentRuntime.getDependencies().eventBus` exposes the same bus for integrations that do not retain the injected instance.

## Failure model

The audit writer is intentionally fail-visible. If an event cannot be canonicalized, exceeds the configured record bound, or an append/fsync operation fails, the ledger enters a sticky unhealthy state. The event bus still contains listener failures according to its existing semantics, so the application must call `ledger.assertHealthy()` or inspect `ledger.getStatus()` at an operator-defined control point before treating audit evidence as complete.

The implementation refuses malformed/truncated/noncanonical history on restart, rejects symbolic-link or non-regular ledger paths, and allows only one writer per resolved path inside a process. Cross-process writer locking is **not** provided: deployments must give one process custody of a ledger path or provide an external lock/serialization boundary.

## Security boundary

The digest chain detects record mutation, deletion, duplication, reordering, and truncation relative to a trusted chain head. SHA-256 chaining alone does **not** prove who authored a ledger and cannot stop an attacker who can rewrite the whole file and recompute every digest. For stronger evidence, periodically anchor the reported `headDigest` in an independent trusted system.

This component has no authority to approve tools, sign or submit Stellar transactions, move funds, infer settlement, or recognize revenue. It is operational evidence only.
