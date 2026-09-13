import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  createPaymentPrepTool,
  digestToolApprovalPayload,
  PAYMENT_PREP_TOOL_NAME,
  StellarPaymentIntentPolicy,
  ToolApprovalPolicy,
  ToolRegistry
} from "../../src/index.js";
import type {
  RuntimeContext,
  ToolApprovalConsumeRequest,
  ToolApprovalStore
} from "../../src/index.js";

const context = {
  runtimeId: "payment-binding-runtime",
  taskId: "payment-binding-task",
  agent: { agentId: "treasury-agent" },
  now: "2026-09-13T10:35:00.000Z"
} as unknown as RuntimeContext;

class ExactDigestStore implements ToolApprovalStore {
  public consumeCalls = 0;

  public constructor(
    private readonly expectedDigest: string,
    private readonly afterConsume?: () => void
  ) {}

  public consume(request: ToolApprovalConsumeRequest) {
    this.consumeCalls += 1;
    let approved = false;
    try {
      approved =
        request.runtimeId === context.runtimeId &&
        request.taskId === context.taskId &&
        request.agentId === context.agent.agentId &&
        request.toolName === PAYMENT_PREP_TOOL_NAME &&
        digestToolApprovalPayload(request.payload) === this.expectedDigest;
    } catch {
      return {
        approved: false,
        reason: "The exact payload graph could not be digested."
      };
    }

    if (approved) {
      this.afterConsume?.();
    }
    return {
      approved,
      ...(approved
        ? {}
        : { reason: "The invocation did not match the approved payload." })
    };
  }
}

function createExecutor(approvalStore: ToolApprovalStore): ActionExecutor {
  const registry = new ToolRegistry();
  registry.register(createPaymentPrepTool());
  const paymentPolicy = new StellarPaymentIntentPolicy({
    wallets: [{ walletId: "treasury", maxAmount: "5" }]
  });
  const policy = new ToolApprovalPolicy({
    approvalStore,
    protectedTools: [PAYMENT_PREP_TOOL_NAME],
    basePolicy: paymentPolicy
  });
  return new ActionExecutor(
    registry,
    5,
    undefined,
    undefined,
    undefined,
    policy
  );
}

describe("payment intent and exact human approval composition", () => {
  it("preserves a sparse payment payload digest through the base policy", async () => {
    const payload = { walletId: "treasury", amount: "5" };
    const approvedDigest = digestToolApprovalPayload(payload);
    const approvalStore = new ExactDigestStore(approvedDigest);
    const executor = createExecutor(approvalStore);

    await expect(
      executor.execute(PAYMENT_PREP_TOOL_NAME, payload, context)
    ).resolves.toMatchObject({
      status: "prepared",
      walletId: "treasury",
      amount: "5",
      assetCode: "XLM"
    });

    expect(approvalStore.consumeCalls).toBe(1);
    expect(digestToolApprovalPayload(payload)).toBe(approvedDigest);
    expect(Reflect.ownKeys(payload)).toEqual(["walletId", "amount"]);
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("detaches and freezes nested audit data before approval consumption", async () => {
    const metadata = {
      invoice: { id: "invoice-42", status: "approved" },
      tags: ["priority", "vendor"]
    };
    const extension = { route: { queue: "settlement" } };
    const payload = {
      walletId: "treasury",
      amount: "5",
      recipientId: undefined,
      assetCode: "XLM",
      assetIssuer: undefined,
      memo: undefined,
      metadata,
      extension
    };
    const approvedDigest = digestToolApprovalPayload(payload);
    const approvalStore = new ExactDigestStore(approvedDigest, () => {
      metadata.invoice.status = "tampered-after-consume";
      extension.route.queue = "attacker-controlled";
    });
    const executor = createExecutor(approvalStore);

    const result = (await executor.execute(
      PAYMENT_PREP_TOOL_NAME,
      payload,
      context
    )) as { metadata?: typeof metadata };

    expect(approvalStore.consumeCalls).toBe(1);
    expect(result.metadata).toEqual({
      invoice: { id: "invoice-42", status: "approved" },
      tags: ["priority", "vendor"]
    });
    expect(payload.metadata).not.toBe(metadata);
    expect(payload.extension).not.toBe(extension);
    expect(Object.isFrozen(payload.metadata)).toBe(true);
    expect(Object.isFrozen(payload.metadata.invoice)).toBe(true);
    expect(Object.isFrozen(payload.metadata.tags)).toBe(true);
    expect(Object.isFrozen(payload.extension.route)).toBe(true);
    expect(digestToolApprovalPayload(payload)).toBe(approvedDigest);
  });

  it("rejects ambiguous nested graphs without invoking accessors or Proxy traps", async () => {
    const paymentPolicy = new StellarPaymentIntentPolicy({
      wallets: [{ walletId: "treasury", maxAmount: "5" }]
    });
    let accessorTouched = false;
    const accessorMetadata: Record<string, unknown> = {};
    Object.defineProperty(accessorMetadata, "invoice", {
      enumerable: true,
      get() {
        accessorTouched = true;
        return "invoice-42";
      }
    });
    let proxyTouched = false;
    const proxyMetadata = new Proxy(
      { invoice: "invoice-42" },
      {
        get(target, property, receiver) {
          proxyTouched = true;
          return Reflect.get(target, property, receiver);
        }
      }
    );
    const shared = { invoice: "invoice-42" };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    for (const metadata of [
      accessorMetadata,
      proxyMetadata,
      { first: shared, second: shared },
      cycle,
      new Date("2026-09-13T10:35:00.000Z")
    ]) {
      await expect(
        paymentPolicy.evaluate({
          toolName: PAYMENT_PREP_TOOL_NAME,
          payload: { walletId: "treasury", amount: "5", metadata },
          context
        })
      ).resolves.toEqual({
        allowed: false,
        reason: "Payment payload changed during policy evaluation."
      });
    }

    expect(accessorTouched).toBe(false);
    expect(proxyTouched).toBe(false);
  });

  it("remains immune to later Object.prototype payment-field pollution", async () => {
    const payload = { walletId: "treasury", amount: "5" };
    const approvalStore = new ExactDigestStore(
      digestToolApprovalPayload(payload)
    );
    const executor = createExecutor(approvalStore);

    await executor.execute(PAYMENT_PREP_TOOL_NAME, payload, context);
    Object.defineProperty(Object.prototype, "assetCode", {
      value: "USDC",
      writable: true,
      enumerable: true,
      configurable: true
    });
    try {
      expect((payload as Record<string, unknown>).assetCode).toBeUndefined();
      expect(Reflect.ownKeys(payload)).toEqual(["walletId", "amount"]);
    } finally {
      delete (Object.prototype as Record<string, unknown>).assetCode;
    }
  });
});
