import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  JsonFileTaskClaimStore,
  type TaskOutcomeReconciliationAuthority
} from "../../src/index.js";

const SHA256 = "c".repeat(64);

const authority: TaskOutcomeReconciliationAuthority = {
  async verifyNotApplied() {
    return {
      confirmedNotApplied: true,
      confirmedQuiescent: true,
      authorityReference: "provider:terminal-not-applied",
      evidenceSha256: SHA256
    };
  }
};

const makeTask = (taskId: string) => ({
  taskId,
  agentId: "agent-finance",
  toolName: "side-effect",
  input: "Execute a side effect only when the durable claim authority permits it.",
  payload: {}
});

describe("cross-runtime unknown outcome reconciliation", () => {
  it("lets a long-lived observer retry after another runtime reconciles the durable generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentlily-reconcile-refresh-"));
    const claimPath = join(dir, "claims.json");
    const ownerClaims = new JsonFileTaskClaimStore(claimPath);
    const observerClaims = new JsonFileTaskClaimStore(claimPath);
    const task = makeTask("shared-reconciled-task");
    let toolInvocations = 0;

    const owner = new AgentRuntime({
      runtimeId: "owner-runtime",
      taskClaimStore: ownerClaims,
      taskOutcomeReconciliationAuthority: authority
    });
    const observer = new AgentRuntime({
      runtimeId: "observer-runtime",
      taskClaimStore: observerClaims
    });
    observer.registerTool({
      name: task.toolName,
      description: "Records a permitted invocation.",
      execute() {
        toolInvocations += 1;
        return { committed: true };
      }
    });

    try {
      await owner.start();
      await observer.start();
      expect(await ownerClaims.claim(task.taskId)).toBe(true);

      await expect(observer.executeTask(task)).rejects.toMatchObject({
        code: "TASK_OUTCOME_UNKNOWN"
      });
      expect(toolInvocations).toBe(0);

      await expect(
        owner.reconcileUnknownOutcome(task.taskId, { providerState: "not-applied" })
      ).resolves.toMatchObject({ releasedForRetry: true });
      expect(await ownerClaims.has(task.taskId)).toBe(false);

      // The observer previously cached TASK_OUTCOME_UNKNOWN. It must revalidate
      // against the shared durable authority instead of requiring a restart.
      await expect(observer.executeTask(task)).resolves.toMatchObject({
        taskId: task.taskId,
        output: { committed: true }
      });
      expect(toolInvocations).toBe(1);
    } finally {
      await owner.stop();
      await observer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not clear a cached unknown marker when a newer durable generation exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentlily-reconcile-new-generation-"));
    const claimPath = join(dir, "claims.json");
    const ownerClaims = new JsonFileTaskClaimStore(claimPath);
    const observerClaims = new JsonFileTaskClaimStore(claimPath);
    const task = makeTask("shared-new-generation-task");
    let toolInvocations = 0;

    const owner = new AgentRuntime({
      runtimeId: "owner-runtime-new-generation",
      taskClaimStore: ownerClaims,
      taskOutcomeReconciliationAuthority: authority
    });
    const observer = new AgentRuntime({
      runtimeId: "observer-runtime-new-generation",
      taskClaimStore: observerClaims
    });
    observer.registerTool({
      name: task.toolName,
      description: "Must not run while any durable generation exists.",
      execute() {
        toolInvocations += 1;
        return { committed: true };
      }
    });

    try {
      await owner.start();
      await observer.start();
      expect(await ownerClaims.claim(task.taskId)).toBe(true);

      await expect(observer.executeTask(task)).rejects.toMatchObject({
        code: "TASK_OUTCOME_UNKNOWN"
      });

      await owner.reconcileUnknownOutcome(task.taskId, {
        providerState: "not-applied"
      });
      expect(await ownerClaims.claim(task.taskId)).toBe(true);
      const newer = await ownerClaims.inspect(task.taskId);
      expect(newer).toBeDefined();

      // The observer's local marker is stale relative to the first generation,
      // but the shared authority contains a genuinely newer tombstone. A durable
      // `has()` revalidation must retain the block rather than clearing it.
      await expect(observer.executeTask(task)).rejects.toMatchObject({
        code: "TASK_OUTCOME_UNKNOWN"
      });
      expect(toolInvocations).toBe(0);
      expect((await ownerClaims.inspect(task.taskId))?.claimId).toBe(
        newer?.claimId
      );
    } finally {
      await owner.stop();
      await observer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
