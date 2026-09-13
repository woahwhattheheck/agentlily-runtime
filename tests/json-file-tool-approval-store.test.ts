import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonFileToolApprovalStore,
  digestToolApprovalPayload
} from "../src/index.js";

const FIXED_NOW = "2026-09-13T11:30:00.000Z";
const roots: string[] = [];

async function tempFile(name = "approvals.json"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlily-approval-"));
  roots.push(root);
  return join(root, name);
}

function request(payload: unknown = { amount: "25.00", destination: "GDEST" }) {
  return {
    runtimeId: "runtime-a",
    taskId: "task-1",
    agentId: "agent-1",
    toolName: "wallet.execute",
    payload
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("JsonFileToolApprovalStore", () => {
  it("persists authority across restart and consumes it exactly once", async () => {
    const filePath = await tempFile();
    const first = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });

    await first.approve({
      approvalId: "approval-1",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: request().payload,
      expiresAt: "2026-09-13T12:00:00.000Z"
    });

    const restarted = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    expect(await restarted.get("approval-1")).toMatchObject({
      approvalId: "approval-1",
      runtimeId: "runtime-a",
      consumedAt: undefined
    });

    const consumed = await restarted.consume(request());
    expect(consumed).toMatchObject({ approved: true });
    expect(consumed.approval?.consumedAt).toBe(FIXED_NOW);

    const third = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    expect((await third.consume(request())).approved).toBe(false);
    expect((await third.get("approval-1"))?.consumedAt).toBe(FIXED_NOW);
  });

  it("serializes competing consumers so only one receives authority", async () => {
    const filePath = await tempFile();
    const grantStore = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    await grantStore.approve({
      approvalId: "approval-race",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: request().payload
    });

    const left = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    const right = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });

    const results = await Promise.all([
      left.consume(request()),
      right.consume(request())
    ]);
    expect(results.filter((result) => result.approved)).toHaveLength(1);
    expect(results.filter((result) => !result.approved)).toHaveLength(1);
  });

  it("does not spend a grant on runtime, task, agent, tool, or payload mismatch", async () => {
    const filePath = await tempFile();
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    await store.approve({
      approvalId: "approval-exact",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: request().payload
    });

    const variants = [
      { ...request(), runtimeId: "runtime-b" },
      { ...request(), taskId: "task-2" },
      { ...request(), agentId: "agent-2" },
      { ...request(), toolName: "wallet.sign" },
      { ...request(), payload: { amount: "26.00", destination: "GDEST" } }
    ];
    for (const variant of variants) {
      expect((await store.consume(variant)).approved).toBe(false);
    }
    expect((await store.get("approval-exact"))?.consumedAt).toBeUndefined();
    expect((await store.consume(request())).approved).toBe(true);
  });

  it("persists revocation and enforces expiry at the exact boundary", async () => {
    const filePath = await tempFile();
    let now = new Date(FIXED_NOW);
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => now
    });

    await store.approve({
      approvalId: "revoked",
      taskId: "task-r",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    });
    expect(await store.revoke("revoked")).toBe(true);
    expect(await store.revoke("revoked")).toBe(false);

    await store.approve({
      approvalId: "expiring",
      taskId: "task-e",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {},
      expiresAt: "2026-09-13T11:31:00.000Z"
    });
    now = new Date("2026-09-13T11:31:00.000Z");

    expect(
      (
        await store.consume({
          runtimeId: "runtime-a",
          taskId: "task-r",
          agentId: "agent-1",
          toolName: "wallet.execute",
          payload: {}
        })
      ).approved
    ).toBe(false);
    expect(
      (
        await store.consume({
          runtimeId: "runtime-a",
          taskId: "task-e",
          agentId: "agent-1",
          toolName: "wallet.execute",
          payload: {}
        })
      ).approved
    ).toBe(false);
  });

  it("refuses duplicate approval IDs without changing the durable grant", async () => {
    const filePath = await tempFile();
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    await store.approve({
      approvalId: "duplicate",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: { amount: 1 }
    });

    await expect(
      store.approve({
        approvalId: "duplicate",
        taskId: "task-2",
        agentId: "agent-2",
        toolName: "wallet.sign",
        payload: { amount: 999 }
      })
    ).rejects.toThrow(/already exists/i);

    expect(await store.get("duplicate")).toMatchObject({
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payloadDigest: digestToolApprovalPayload({ amount: 1 })
    });
  });

  it("returns clones so callers cannot mutate durable authority in memory", async () => {
    const filePath = await tempFile();
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    await store.approve({
      approvalId: "clone",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    });

    const read = await store.get("clone");
    expect(read).toBeDefined();
    read!.taskId = "mutated";
    expect((await store.get("clone"))?.taskId).toBe("task-1");
  });

  it.each([
    ["invalid JSON", "{not-json"],
    [
      "unknown top-level field",
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: "runtime-a",
        approvals: [],
        bypass: true
      })
    ],
    [
      "wrong runtime",
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: "runtime-b",
        approvals: []
      })
    ],
    [
      "invalid digest",
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: "runtime-a",
        approvals: [
          {
            approvalId: "bad",
            runtimeId: "runtime-a",
            taskId: "task-1",
            agentId: "agent-1",
            toolName: "wallet.execute",
            payloadDigest: "not-a-digest",
            grantedAt: FIXED_NOW
          }
        ]
      })
    ],
    [
      "noncanonical timestamp",
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: "runtime-a",
        approvals: [
          {
            approvalId: "bad-time",
            runtimeId: "runtime-a",
            taskId: "task-1",
            agentId: "agent-1",
            toolName: "wallet.execute",
            payloadDigest: digestToolApprovalPayload({}),
            grantedAt: "2026-09-13T11:30:00Z"
          }
        ]
      })
    ],
    [
      "duplicate durable approval IDs",
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: "runtime-a",
        approvals: [
          {
            approvalId: "same",
            runtimeId: "runtime-a",
            taskId: "task-1",
            agentId: "agent-1",
            toolName: "wallet.execute",
            payloadDigest: digestToolApprovalPayload({ one: 1 }),
            grantedAt: FIXED_NOW
          },
          {
            approvalId: "same",
            runtimeId: "runtime-a",
            taskId: "task-2",
            agentId: "agent-2",
            toolName: "wallet.sign",
            payloadDigest: digestToolApprovalPayload({ two: 2 }),
            grantedAt: FIXED_NOW
          }
        ]
      })
    ],
    [
      "unknown record field",
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: "runtime-a",
        approvals: [
          {
            approvalId: "bad",
            runtimeId: "runtime-a",
            taskId: "task-1",
            agentId: "agent-1",
            toolName: "wallet.execute",
            payloadDigest: digestToolApprovalPayload({}),
            grantedAt: FIXED_NOW,
            allowForever: true
          }
        ]
      })
    ]
  ])("fails closed on corrupted durable state: %s", async (_label, raw) => {
    const filePath = await tempFile();
    await writeFile(filePath, raw, "utf8");
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });

    await expect(store.get("anything")).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED"
    });
  });

  it("fails closed on a stranded cross-process lock instead of breaking it", async () => {
    const filePath = await tempFile();
    await mkdir(`${resolve(filePath)}.lock`, { recursive: true });
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW),
      lockTimeoutMs: 20,
      lockRetryDelayMs: 5
    });

    await expect(store.get("anything")).rejects.toMatchObject({
      code: "STORAGE_LOCKED"
    });
  });

  it("writes a versioned runtime-bound authority envelope", async () => {
    const filePath = await tempFile();
    const store = new JsonFileToolApprovalStore(filePath, {
      runtimeId: "runtime-a",
      now: () => new Date(FIXED_NOW)
    });
    await store.approve({
      approvalId: "envelope",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: {}
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).toMatchObject({ schemaVersion: 1, runtimeId: "runtime-a" });
    expect(Object.keys(raw).sort()).toEqual([
      "approvals",
      "runtimeId",
      "schemaVersion"
    ]);
  });
});
