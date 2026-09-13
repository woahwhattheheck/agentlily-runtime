# Durable task-claim safety

`JsonFileTaskClaimStore` is the runtime safety authority for task IDs whose external side-effect outcome may be ambiguous. A task claim is written before the tool runs and is released only after the runtime knows whether retrying that logical task ID is safe.

## Cross-process serialization

The JSON claim file is protected by an adjacent filesystem lock directory at:

```text
<absolute-claim-file-path>.lock
```

Creating a directory is used as the cross-process create-if-absent primitive. Every `claim()`, `has()`, and `release()` operation must acquire this lock before reading or replacing the JSON claim file. The existing in-process queue is retained to avoid unnecessary local contention, but it is not the safety boundary.

This matters when multiple Node.js processes share the same `taskClaimStoragePath`: without a process-shared critical section, two processes can both observe an unclaimed task ID and both execute the same externally-effectful task.

## Fail-closed crash behavior

If another process owns the lock, operations retry briefly. The built-in defaults are:

- `lockTimeoutMs: 5000`
- `lockRetryDelayMs: 10`

They can be overridden through the optional second argument to `JsonFileTaskClaimStore`.

If the timeout expires, the operation throws `RuntimeError` with code `STORAGE_LOCKED`. The runtime does not execute the tool through that failed claim attempt.

A process crash can leave the lock directory behind. That intentionally fails closed: a later process cannot safely distinguish a stale lock from a still-running process that may be mutating the same claim authority. Before manually removing an orphaned lock, an operator must verify that no process is still using that claim file and reconcile any task whose external outcome could be ambiguous.

## JSON compatibility

The durable claim file remains the same JSON array of `{ taskId, claimedAt }` records introduced with the persistent task-claim store. Locking changes serialization authority only; it does not migrate or reinterpret existing claim records.

Atomic replacement of the JSON file is retained. Temporary-file cleanup and lock-directory cleanup are best-effort after a durable state transition; cleanup failure must not misreport a completed durable transition in a way that could encourage unsafe retry.
