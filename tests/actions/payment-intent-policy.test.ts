import { describe, expect, it } from "vitest";
import {
  PAYMENT_PREP_TOOL_NAME,
  StellarPaymentIntentPolicy
} from "../../src/index.js";
import type {
  RuntimeContext,
  StellarPaymentWalletPolicy
} from "../../src/index.js";

const ISSUER_A = "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGF";
const context = {
  runtimeId: "payment-policy-runtime",
  taskId: "payment-policy-task",
  agent: { agentId: "treasury-agent" },
  now: "2026-09-13T10:00:00.000Z"
} as unknown as RuntimeContext;

function createPolicy(overrides: Partial<StellarPaymentWalletPolicy> = {}) {
  return new StellarPaymentIntentPolicy({
    wallets: [
      {
        walletId: "treasury",
        maxAmount: "10.0000001",
        allowedRecipientIds: ["merchant-a"],
        allowedAssets: [
          { assetCode: "XLM" },
          { assetCode: "USDC", assetIssuer: ISSUER_A }
        ],
        requireRecipient: true,
        requireMemo: true,
        ...overrides
      }
    ]
  });
}

async function decide(
  policy: StellarPaymentIntentPolicy,
  payload: unknown,
  toolName = PAYMENT_PREP_TOOL_NAME
) {
  return policy.evaluate({ toolName, payload, context });
}

describe("StellarPaymentIntentPolicy", () => {
  it("allows an exact-boundary payment for the configured wallet, recipient, and asset", async () => {
    const policy = createPolicy();

    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "10.0000001",
        recipientId: "merchant-a",
        assetCode: "XLM",
        memo: "invoice-42"
      })
    ).resolves.toEqual({ allowed: true });
  });

  it("denies one stroop above the configured maximum", async () => {
    const policy = createPolicy();

    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "10.0000002",
        recipientId: "merchant-a",
        memo: "invoice-42"
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Payment amount exceeds the wallet policy limit."
    });
  });

  it("denies unconfigured wallets, recipients, assets, and missing required fields", async () => {
    const policy = createPolicy();
    const base = {
      walletId: "treasury",
      amount: "1",
      recipientId: "merchant-a",
      memo: "invoice-42"
    };

    await expect(
      decide(policy, { ...base, walletId: "other-wallet" })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Wallet is not authorized for payment preparation."
    });
    await expect(
      decide(policy, { ...base, recipientId: "merchant-b" })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Payment recipient is not authorized by wallet policy."
    });
    await expect(
      decide(policy, {
        ...base,
        assetCode: "EUR",
        assetIssuer: ISSUER_A
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Payment asset is not authorized by wallet policy."
    });
    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "1",
        memo: "invoice-42"
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Payment policy requires an explicit recipient."
    });
    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "1",
        recipientId: "merchant-a"
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Payment policy requires a non-empty memo."
    });
  });

  it("allows an explicitly configured issued asset by exact code and issuer identity", async () => {
    const policy = createPolicy();

    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "2.5",
        recipientId: "merchant-a",
        assetCode: "USDC",
        assetIssuer: ISSUER_A,
        memo: "invoice-42"
      })
    ).resolves.toEqual({ allowed: true });
  });

  it("reuses payment preparation validation and sanitizes invalid-intent diagnostics", async () => {
    const policy = createPolicy();

    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "1.00000001",
        recipientId: "merchant-a",
        memo: "invoice-42"
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Payment intent is invalid."
    });

    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "1",
        recipientId: "merchant-a",
        assetCode: "USDC",
        assetIssuer: `${ISSUER_A.slice(0, -1)}A`,
        memo: "invoice-42"
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Payment intent is invalid."
    });
  });

  it("denies accessor and Proxy payloads without invoking their value traps", async () => {
    const policy = createPolicy();
    let accessorTouched = false;
    const accessorPayload: Record<string, unknown> = {
      amount: "1",
      recipientId: "merchant-a",
      memo: "invoice-42"
    };
    Object.defineProperty(accessorPayload, "walletId", {
      enumerable: true,
      get() {
        accessorTouched = true;
        return "treasury";
      }
    });

    await expect(decide(policy, accessorPayload)).resolves.toEqual({
      allowed: false,
      reason: "Payment policy requires a plain data payload."
    });
    expect(accessorTouched).toBe(false);

    let proxyTouched = false;
    const proxyPayload = new Proxy(
      {
        walletId: "treasury",
        amount: "1",
        recipientId: "merchant-a",
        memo: "invoice-42"
      },
      {
        get(target, property, receiver) {
          proxyTouched = true;
          return Reflect.get(target, property, receiver);
        }
      }
    );

    await expect(decide(policy, proxyPayload)).resolves.toEqual({
      allowed: false,
      reason: "Payment policy requires a plain data payload."
    });
    expect(proxyTouched).toBe(false);
  });

  it("snapshots mutable allowlist configuration", async () => {
    const recipients = ["merchant-a"];
    const assets = [{ assetCode: "XLM" }];
    const policy = createPolicy({
      allowedRecipientIds: recipients,
      allowedAssets: assets
    });

    recipients.push("merchant-after-construction");
    assets.push({ assetCode: "USDC" });

    await expect(
      decide(policy, {
        walletId: "treasury",
        amount: "1",
        recipientId: "merchant-after-construction",
        memo: "invoice-42"
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Payment recipient is not authorized by wallet policy."
    });
  });

  it("binds an allowed intent to the original payload object across await boundaries", async () => {
    const policy = createPolicy({
      maxAmount: "5",
      allowedRecipientIds: undefined,
      allowedAssets: undefined,
      requireRecipient: false,
      requireMemo: false
    });
    const payload = { walletId: "treasury", amount: "5" };

    await expect(decide(policy, payload)).resolves.toEqual({ allowed: true });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(() => {
      payload.amount = "500";
    }).toThrow(TypeError);
    expect(payload.amount).toBe("5");
  });

  it("denies when payment fields change while policy evaluation is suspended", async () => {
    const policy = createPolicy({
      maxAmount: "5",
      allowedRecipientIds: undefined,
      allowedAssets: undefined,
      requireRecipient: false,
      requireMemo: false
    });
    const payload = { walletId: "treasury", amount: "1" };

    queueMicrotask(() => {
      payload.amount = "500";
    });

    await expect(decide(policy, payload)).resolves.toEqual({
      allowed: false,
      reason: "Payment payload changed during policy evaluation."
    });
    expect(Object.isFrozen(payload)).toBe(false);
    expect(payload.amount).toBe("500");
  });

  it("passes non-payment tools through for composition with generic policies", async () => {
    const policy = createPolicy();

    await expect(decide(policy, { arbitrary: true }, "account.read")).resolves.toEqual({
      allowed: true
    });
  });

  it("rejects unsafe policy configuration at construction time", () => {
    expect(
      () =>
        new StellarPaymentIntentPolicy({
          wallets: [
            { walletId: "treasury", maxAmount: "0" }
          ]
        })
    ).toThrow(RangeError);

    expect(
      () =>
        new StellarPaymentIntentPolicy({
          wallets: [
            { walletId: "treasury" },
            { walletId: "treasury" }
          ]
        })
    ).toThrow(/Duplicate payment policy/);

    expect(
      () =>
        new StellarPaymentIntentPolicy({
          wallets: [
            {
              walletId: "treasury",
              allowedAssets: [{ assetCode: "USDC" }]
            }
          ]
        })
    ).toThrow(/must specify an issuer/);
  });
});
