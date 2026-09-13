import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonFileToolApprovalStore,
  ToolApprovalPolicy,
  type ToolApprovalConsumeRequest
} from "../src/index.js";
import type { RuntimeContext } from "../src/index.js";
import {
  AgentInstanceManager,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  UnconfiguredModelProvider
} from "../src/index.js";

const FIXED_NOW = "2026-09-13T11:00:00.000Z";

function invocation(
  taskId = "task-durable",
  amount = "25.00"
): ToolApprovalConsumeRequest {
  return {
    taskId,
    agentId: "agent-treasury",
    toolName: "wallet.execute",
    payload: { amount, asset: "XLM" }
  };
}

function context(taskId = "task-durable"): RuntimeContext {
  return {
    runtimeId: "runtime-durable",
    taskId,
    agent: new AgentInstanceManager().getOrCreate("agent-treasury"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: FIXED_NOW
  };
}

describe("JsonFileToolApprovalStore", () => {
  it("persists a grant across store instances and consumes it once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-file-"));
    const approvalPath = join(directory, "approvals.json");

    try {
      const first = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date(FIXED_NOW)
      });
      await first.approve({
        approvalId: "approval-persisted",
        ...invocation()
      });

      const second = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date("2026-09-13T11:00:01.000Z")
      });
      expect((await second.get("approval-persisted"))?.consumedAt).toBeUndefined();

      const consumed = await second.consume(invocation());
      expect(consumed).toMatchObject({ approved: true });
      expect(consumed.approval?.consumedAt).toBe(
        "2026-09-13T11:00:01.000Z"
      );

      const third = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date("2026-09-13T11:00:02.000Z")
      });
      expect((await third.consume(invocation())).approved).toBe(false);
      expect((await third.get("approval-persisted"))?.consumedAt).toBe(
        "2026-09-13T11:00:01.000Z"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits exactly one concurrent consumer across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-race-"));
    const approvalPath = join(directory, "approvals.json");
    const options = {
      now: () => new Date(FIXED_NOW),
      lockTimeoutMs: 2_000,
      lockRetryDelayMs: 2
    };

    try {
      const writer = new JsonFileToolApprovalStore(approvalPath, options);
      await writer.approve({
        approvalId: "approval-race",
        ...invocation("task-race")
      });

      const contenders = Array.from(
        { length: 12 },
        () => new JsonFileToolApprovalStore(approvalPath, options)
      );
      const results = await Promise.all(
        contenders.map((store) => store.consume(invocation("task-race")))
      );

      expect(results.filter((result) => result.approved)).toHaveLength(1);
      expect(
        (await writer.get("approval-race"))?.consumedAt
      ).toBe(FIXED_NOW);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on an unreconciled adjacent lock without deleting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-lock-"));
    const approvalPath = join(directory, "approvals.json");
    const lockPath = `${resolve(approvalPath)}.lock`;

    try {
      await mkdir(lockPath);
      const store = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date(FIXED_NOW),
        lockTimeoutMs: 20,
        lockRetryDelayMs: 2
      });

      await expect(
        store.approve({
          approvalId: "approval-locked",
          ...invocation()
        })
      ).rejects.toMatchObject({
        code: "STORAGE_LOCKED",
        details: {
          filePath: resolve(approvalPath),
          lockPath,
          timeoutMs: 20
        }
      });

      await expect(mkdir(lockPath)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupted authority and preserves the bad file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-corrupt-"));
    const approvalPath = join(directory, "approvals.json");

    try {
      await writeFile(approvalPath, "{not-json", "utf-8");
      const store = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date(FIXED_NOW)
      });

      await expect(store.consume(invocation())).rejects.toMatchObject({
        code: "STORAGE_CORRUPTED"
      });
      await expect(store.list()).rejects.toMatchObject({
        code: "STORAGE_CORRUPTED"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists revocation and duplicate-id protection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-revoke-"));
    const approvalPath = join(directory, "approvals.json");

    try {
      const first = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date(FIXED_NOW)
      });
      await first.approve({
        approvalId: "approval-revoked",
        ...invocation()
      });
      expect(await first.revoke("approval-revoked")).toBe(true);
      expect(await first.revoke("approval-revoked")).toBe(false);

      const second = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date("2026-09-13T11:00:01.000Z")
      });
      expect((await second.get("approval-revoked"))?.revokedAt).toBe(FIXED_NOW);
      expect((await second.consume(invocation())).approved).toBe(false);
      await expect(
        second.approve({
          approvalId: "approval-revoked",
          ...invocation()
        })
      ).rejects.toThrow(/already exists/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("matches the in-memory expiry contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-expiry-"));
    const approvalPath = join(directory, "approvals.json");
    let now = new Date(FIXED_NOW);

    try {
      const store = new JsonFileToolApprovalStore(approvalPath, {
        now: () => now
      });
      await store.approve({
        approvalId: "approval-expiring",
        ...invocation(),
        expiresAt: "2026-09-13T11:01:00.000Z"
      });

      now = new Date("2026-09-13T11:01:00.000Z");
      expect((await store.consume(invocation())).approved).toBe(false);
      expect(
        (await store.get("approval-expiring"))?.consumedAt
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("plugs directly into ToolApprovalPolicy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlily-approval-policy-"));
    const approvalPath = join(directory, "approvals.json");

    try {
      const store = new JsonFileToolApprovalStore(approvalPath, {
        now: () => new Date(FIXED_NOW)
      });
      const policy = new ToolApprovalPolicy({
        approvalStore: store,
        protectedTools: ["wallet.execute"]
      });
      const request = invocation("task-policy");
      const runtimeContext = context("task-policy");

      await expect(
        policy.evaluate({
          toolName: request.toolName,
          payload: request.payload,
          context: runtimeContext
        })
      ).resolves.toMatchObject({ allowed: false });

      await store.approve({
        approvalId: "approval-policy",
        ...request
      });
      await expect(
        policy.evaluate({
          toolName: request.toolName,
          payload: request.payload,
          context: runtimeContext
        })
      ).resolves.toEqual({ allowed: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
