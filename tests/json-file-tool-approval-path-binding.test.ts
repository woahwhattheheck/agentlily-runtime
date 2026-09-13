import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileToolApprovalStore } from "../src/index.js";

const FIXED_NOW = "2026-09-13T12:00:00.000Z";
const roots: string[] = [];

async function tempFile(name = "approvals.json"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlily-approval-path-"));
  roots.push(root);
  return join(root, name);
}

function request() {
  return {
    runtimeId: "runtime-a",
    taskId: "task-1",
    agentId: "agent-1",
    toolName: "wallet.execute",
    payload: { amount: "25.00", destination: "GDEST" }
  };
}

function createStore(filePath: string) {
  return new JsonFileToolApprovalStore(filePath, {
    runtimeId: "runtime-a",
    now: () => new Date(FIXED_NOW)
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("durable approval filesystem authority identity", () => {
  it("rejects an approval-file symlink without spending the real grant", async () => {
    const filePath = await tempFile("real.json");
    const aliasPath = join(dirname(filePath), "alias.json");
    const store = createStore(filePath);
    await store.approve({
      approvalId: "symlink-grant",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: request().payload
    });
    await symlink(filePath, aliasPath, "file");

    await expect(createStore(aliasPath).consume(request())).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED"
    });
    expect((await store.consume(request())).approved).toBe(true);
  });

  it("fails closed while an approval file has multiple hard links", async () => {
    const filePath = await tempFile("real-hard.json");
    const aliasPath = join(dirname(filePath), "hard-alias.json");
    const store = createStore(filePath);
    await store.approve({
      approvalId: "hard-grant",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: request().payload
    });
    await link(filePath, aliasPath);

    await expect(store.consume(request())).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED"
    });
    await expect(createStore(aliasPath).consume(request())).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED"
    });

    await unlink(aliasPath);
    expect((await store.consume(request())).approved).toBe(true);
  });

  it("canonicalizes parent-directory symlink aliases to one lock authority", async () => {
    const marker = await tempFile("marker");
    const root = dirname(marker);
    const realDir = join(root, "real-dir");
    const aliasDir = join(root, "alias-dir");
    await mkdir(realDir);
    await symlink(realDir, aliasDir, "dir");

    const realStore = createStore(join(realDir, "shared.json"));
    const aliasStore = createStore(join(aliasDir, "shared.json"));
    await realStore.approve({
      approvalId: "parent-alias-grant",
      taskId: "task-1",
      agentId: "agent-1",
      toolName: "wallet.execute",
      payload: request().payload
    });

    const results = await Promise.all([
      realStore.consume(request()),
      aliasStore.consume(request())
    ]);
    expect(results.filter((result) => result.approved)).toHaveLength(1);
  });
});
