import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  createPaymentPrepTool,
  type PaymentPrepPayload
} from "../../src/actions/payment-prep-action.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

const ISSUER_A = "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGF";
const ISSUER_B = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const context = {
  taskId: "stellar-intent-authority",
  now: "2026-09-13T08:20:00.000Z"
} as unknown as RuntimeContext;

function execute(payload: PaymentPrepPayload) {
  return createPaymentPrepTool().execute({ payload, context });
}

describe("payment preparation Stellar intent authority", () => {
  it("requires a valid issuer for every non-native classic asset", () => {
    expect(() =>
      execute({ walletId: "wallet-a", amount: "1", assetCode: "USDC" })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "assetIssuer" }
      })
    );

    expect(() =>
      execute({
        walletId: "wallet-a",
        amount: "1",
        assetCode: "USDC",
        assetIssuer:
          "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGA"
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "assetIssuer" }
      })
    );

    const prepared = execute({
      walletId: "wallet-a",
      amount: "1",
      assetCode: "USDC",
      assetIssuer: ISSUER_A
    });
    expect(prepared.assetCode).toBe("USDC");
    expect(prepared.assetIssuer).toBe(ISSUER_A);
  });

  it.each(["USDC-1", "ABCDEFGHIJKLM", "USD C", "💵"])(
    "rejects protocol-invalid classic asset code %j",
    (assetCode) => {
      expect(() =>
        execute({
          walletId: "wallet-a",
          amount: "1",
          assetCode,
          assetIssuer: ISSUER_A
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { fieldName: "assetCode" }
        })
      );
    }
  );

  it("rejects an issuer on native XLM", () => {
    expect(() =>
      execute({
        walletId: "wallet-a",
        amount: "1",
        assetCode: "XLM",
        assetIssuer: ISSUER_A
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "assetIssuer" }
      })
    );
  });

  it("binds issued-asset stub identity to the issuer", () => {
    const first = execute({
      walletId: "wallet-a",
      amount: "12.5",
      assetCode: "USD",
      assetIssuer: ISSUER_A,
      memo: "invoice-7"
    });
    const second = execute({
      walletId: "wallet-a",
      amount: "12.5",
      assetCode: "USD",
      assetIssuer: ISSUER_B,
      memo: "invoice-7"
    });

    expect(first.transactionStubId).not.toBe(second.transactionStubId);
  });

  it("rejects non-string memos and enforces Stellar MEMO_TEXT UTF-8 bytes", () => {
    expect(() =>
      execute({
        walletId: "wallet-a",
        amount: "1",
        memo: { routing: "bad" } as unknown as string
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "memo" }
      })
    );

    expect(
      execute({ walletId: "wallet-a", amount: "1", memo: "x".repeat(28) })
        .memo
    ).toBe("x".repeat(28));
    expect(
      execute({ walletId: "wallet-a", amount: "1", memo: "🚀".repeat(7) })
        .memo
    ).toBe("🚀".repeat(7));

    expect(() =>
      execute({ walletId: "wallet-a", amount: "1", memo: "x".repeat(29) })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: expect.objectContaining({
          fieldName: "memo",
          memoBytes: 29,
          maxMemoBytes: 28
        })
      })
    );
    expect(() =>
      execute({ walletId: "wallet-a", amount: "1", memo: "🚀".repeat(8) })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: expect.objectContaining({
          fieldName: "memo",
          memoBytes: 32,
          maxMemoBytes: 28
        })
      })
    );
  });

  it("preserves the existing native-XLM stub identity contract", () => {
    const payload: PaymentPrepPayload = {
      walletId: "wallet-a",
      amount: "25.00",
      assetCode: "XLM",
      memo: "monthly rebalance"
    };
    const prepared = execute(payload);
    const canonicalIntent = JSON.stringify([
      context.taskId,
      payload.walletId,
      null,
      "XLM",
      "250000000",
      payload.memo
    ]);
    const expectedDigest = createHash("sha256")
      .update(canonicalIntent, "utf8")
      .digest("hex");

    expect(prepared.assetIssuer).toBeUndefined();
    expect(prepared.transactionStubId).toBe(
      `stellar-stub-${context.taskId}-${payload.walletId}-${expectedDigest}`
    );
  });
});
