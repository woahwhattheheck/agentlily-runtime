import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  InMemoryTaskClaimStore,
  JsonFileTaskClaimStore,
  RuntimeEventBus,
  type MemoryStore,
  type TaskOutcomeReconciliationAuthority
} from "../../src/index.js";

const SHA256 = "a".repeat(64);

const task = {
  taskId: "payment-reconcile-1",
  agentId: "agent-finance",
  toolName: "prepare-external-effect",
  input: "Prepare an externally-effectful action",
  payload: {}
};

const verifiedAuthority: TaskOutcomeReconciliationAuthority = {
  async verifyNotApplied() {
    return {
      confirmedNotApplied: true,
      confirmedQuiescent: true,
      authorityReference: "provider-status:terminal-not-applied",
      evidenceSha256: SHA256
    };
  }
};

describe("unknown task outcome reconciliation", () => {
  it("releases only a generation-matched claim and emits a safe receipt", async () => {
    const claims = new InMemoryTaskClaimStore();
    let rejectPersistence = true;
    const memoryStore: MemoryStore = {
      async append() {
        if (rejectPersistence) {
          throw new Error("memory temporarily unavailable");
        }
      },
      async listByAgent() {
        return [];
      }
    };
    const eventBus = new RuntimeEventBus();
    const reconciledEvents: unknown[] = [];
    eventBus.on("runtime.task.reconciled", (event) => {
      reconciledEvents.push(event.payload);
    });

    let toolInvocations = 0;
    const runtime = new AgentRuntime({
      runtimeId: "reconciliation-runtime",
      memoryStore,
      taskClaimStore: claims,
      eventBus,
      taskOutcomeReconciliationAuthority: verifiedAuthority
    });
    runtime.registerTool({
      name: task.toolName,
      description: "A deterministic test tool.",
      execute() {
        toolInvocations += 1;
        return { prepared: true };
      }
    });
    await runtime.start();

    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "EXECUTION_FAILED"
    });
    expect(toolInvocations).toBe(1);
    expect(await claims.has(task.taskId)).toBe(true);

    const receipt = await runtime.reconcileUnknownOutcome(task.taskId, {
      providerState: "not-applied"
    });
    expect(receipt).toMatchObject({
      taskId: task.taskId,
      authorityReference: "provider-status:terminal-not-applied",
      evidenceSha256: SHA256,
      releasedForRetry: true
    });
    expect(receipt.claimId).toEqual(expect.any(String));
    expect(await claims.has(task.taskId)).toBe(false);
    expect(reconciledEvents).toEqual([
      {
        runtimeId: "reconciliation-runtime",
        ...receipt
      }
    ]);
    expect(JSON.stringify(reconciledEvents)).not.toContain("providerState");

    rejectPersistence = false;
    await expect(runtime.executeTask(task)).resolves.toMatchObject({
      taskId: task.taskId,
      output: { prepared: true }
    });
    expect(toolInvocations).toBe(2);
    await runtime.stop();
  });

  it("fails closed without an explicit reconciliation authority", async () => {
    const claims = new InMemoryTaskClaimStore();
    expect(await claims.claim("unknown-1")).toBe(true);

    const runtime = new AgentRuntime({
      runtimeId: "no-reconciliation-authority",
      taskClaimStore: claims
    });
    await runtime.start();

    await expect(
      runtime.reconcileUnknownOutcome("unknown-1", {})
    ).rejects.toMatchObject({
      code: "TASK_RECONCILIATION_UNAVAILABLE"
    });
    expect(await claims.has("unknown-1")).toBe(true);
    await runtime.stop();
  });

  it("rejects incomplete authority proof without releasing the claim", async () => {
    const claims = new InMemoryTaskClaimStore();
    expect(await claims.claim("unknown-2")).toBe(true);

    const runtime = new AgentRuntime({
      runtimeId: "incomplete-reconciliation-proof",
      taskClaimStore: claims,
      taskOutcomeReconciliationAuthority: {
        async verifyNotApplied() {
          return {
            confirmedNotApplied: true,
            confirmedQuiescent: false,
            authorityReference: "provider-status:request-still-running",
            evidenceSha256: SHA256
          };
        }
      }
    });
    await runtime.start();

    await expect(
      runtime.reconcileUnknownOutcome("unknown-2", {})
    ).rejects.toMatchObject({ code: "TASK_RECONCILIATION_REJECTED" });
    expect(await claims.has("unknown-2")).toBe(true);
    await runtime.stop();
  });

  it("does not let a stale reconciliation generation delete a later retry claim", async () => {
    const claims = new InMemoryTaskClaimStore();
    expect(await claims.claim("aba-task")).toBe(true);
    const first = await claims.inspect("aba-task");
    expect(first).toBeDefined();

    expect(await claims.releaseIfMatches(first!)).toBe(true);
    expect(await claims.claim("aba-task")).toBe(true);
    const second = await claims.inspect("aba-task");
    expect(second).toBeDefined();
    expect(second?.claimId).not.toBe(first?.claimId);

    expect(await claims.releaseIfMatches(first!)).toBe(false);
    expect(await claims.has("aba-task")).toBe(true);
    expect((await claims.inspect("aba-task"))?.claimId).toBe(second?.claimId);
  });

  it("keeps legacy durable claims fail-closed for automatic reconciliation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentlily-legacy-claim-"));
    const claimPath = join(dir, "claims.json");
    await writeFile(
      claimPath,
      JSON.stringify([
        {
          taskId: "legacy-task",
          claimedAt: "2026-09-12T00:00:00.000Z"
        }
      ]),
      "utf-8"
    );

    try {
      const claims = new JsonFileTaskClaimStore(claimPath);
      const runtime = new AgentRuntime({
        runtimeId: "legacy-reconciliation-runtime",
        taskClaimStore: claims,
        taskOutcomeReconciliationAuthority: verifiedAuthority
      });
      await runtime.start();

      await expect(
        runtime.reconcileUnknownOutcome("legacy-task", {})
      ).rejects.toMatchObject({
        code: "TASK_RECONCILIATION_UNAVAILABLE"
      });
      expect(await claims.has("legacy-task")).toBe(true);
      expect(JSON.parse(await readFile(claimPath, "utf-8"))).toEqual([
        {
          taskId: "legacy-task",
          claimedAt: "2026-09-12T00:00:00.000Z"
        }
      ]);
      await runtime.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses reconciliation while the same runtime still owns execution custody", async () => {
    let settle!: () => void;
    const pending = new Promise<{ prepared: boolean }>((resolve) => {
      settle = () => resolve({ prepared: true });
    });
    const runtime = new AgentRuntime({
      runtimeId: "active-reconciliation-runtime",
      maxTaskDurationMs: 5,
      taskOutcomeReconciliationAuthority: verifiedAuthority
    });
    runtime.registerTool({
      name: task.toolName,
      description: "A delayed test tool.",
      execute() {
        return pending;
      }
    });
    await runtime.start();

    await expect(runtime.executeTask(task)).rejects.toMatchObject({
      code: "EXECUTION_FAILED"
    });
    await expect(
      runtime.reconcileUnknownOutcome(task.taskId, {})
    ).rejects.toMatchObject({ code: "TASK_RECONCILIATION_CONFLICT" });

    settle();
    await Promise.resolve();
    await runtime.stop({ drainTimeoutMs: 100 });
  });
});
