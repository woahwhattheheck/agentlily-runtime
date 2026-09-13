# Durable task-claim safety

`JsonFileTaskClaimStore` is the runtime safety authority for task IDs whose external side-effect outcome may be ambiguous. A task claim is written before the tool runs and is released only after the runtime knows whether retrying that logical task ID is safe.

## Cross-process serialization

The JSON claim file is protected by an adjacent filesystem lock directory at:

```text
<absolute-claim-file-path>.lock
```

Creating a directory is used as the cross-process create-if-absent primitive. Every claim-store read/modify/write operation, including generation-bound reconciliation release, must acquire this lock before reading or replacing the JSON claim file. The existing in-process queue is retained to avoid unnecessary local contention, but it is not the safety boundary.

This matters when multiple Node.js processes share the same `taskClaimStoragePath`: without a process-shared critical section, two processes can both observe an unclaimed task ID and both execute the same externally-effectful task.

Every process that shares one claim file must participate in this lock protocol. During a rolling upgrade, a pre-lock runtime can still race a locking runtime because the older process does not honor the adjacent lock directory; do not run mixed versions against the same claim path while externally-effectful tasks are enabled.

## Fail-closed crash behavior

If another process owns the lock, operations retry briefly. The built-in defaults are:

- `lockTimeoutMs: 5000`
- `lockRetryDelayMs: 10`

They can be overridden through the optional second argument to `JsonFileTaskClaimStore`.

If the timeout expires, the operation throws `RuntimeError` with code `STORAGE_LOCKED`. The runtime does not execute the tool through that failed claim attempt.

A process crash can leave the lock directory behind. That intentionally fails closed: a later process cannot safely distinguish a stale lock from a still-running process that may be mutating the same claim authority. Before manually removing an orphaned lock, an operator must verify that no process is still using that claim file and reconcile any task whose external outcome could be ambiguous.

## Unknown-outcome reconciliation

A tombstone can outlive the ambiguity that created it. For example, a provider or worker control plane may later prove that a timed-out request reached a terminal state without applying its external side effect. The runtime can recover that logical task ID through `AgentRuntime.reconcileUnknownOutcome(taskId, evidence)`, but only when `taskOutcomeReconciliationAuthority` is explicitly configured.

There is intentionally no permissive built-in authority. The configured authority must return all of the following before the runtime will release a tombstone:

- `confirmedNotApplied: true`: the external effect was not applied;
- `confirmedQuiescent: true`: the old attempt cannot still commit later;
- a non-empty, non-secret `authorityReference` suitable for an audit event;
- a lowercase SHA-256 digest of the retained authority evidence.

The opaque `evidence` argument is passed only to the authority. It is not logged, emitted, or persisted by the runtime.

Current claims carry an opaque `claimId` generation. Reconciliation snapshots that generation before authority verification and removes the claim only with `releaseIfMatches()`. If another reconciler already released the old claim and a retry acquired a new generation, the stale reconciler cannot delete the new claim. That is the ABA safety boundary.

Reconciliation also refuses to run while the same runtime still owns execution custody for the task. Deployments with multiple worker processes must make cross-process liveness/quiescence part of the configured authority proof; absence from a provider snapshot is not enough if an old request or worker can still commit later.

Legacy durable records without `claimId` remain valid duplicate-execution tombstones but are deliberately not auto-reconcilable. Preserve them fail-closed unless an operator completes an out-of-band migration/review appropriate to that deployment.

A successful release emits `runtime.task.reconciled` with only the task/claim identity, timestamps, authority reference, evidence SHA-256 and `releasedForRetry: true`.

## JSON compatibility

The durable claim file remains a JSON array. New records are `{ taskId, claimedAt, claimId }`. Legacy `{ taskId, claimedAt }` records continue to load and fence execution; they are not silently upgraded because inventing a reconciliation generation for an old ambiguous execution would weaken the safety boundary.

Atomic replacement of the JSON file is retained. Temporary-file cleanup and lock-directory cleanup are best-effort after a durable state transition; cleanup failure must not misreport a completed durable transition in a way that could encourage unsafe retry.
