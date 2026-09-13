import { describe, expect, it } from "vitest";
import {
  createPaymentPrepTool,
  type PaymentPrepPayload
} from "../../src/actions/payment-prep-action.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

const ISSUER_A = "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGF";
const ISSUER_BAD_CHECKSUM =
  "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGA";
const context = {
  taskId: "stellar-authority",
  now: "2026-09-13T08:30:00.000Z"
} as unknown as RuntimeContext;

function prepare(payload: PaymentPrepPayload) {
  return createPaymentPrepTool().execute({ payload, context });
}

describe("payment preparation Stellar protocol authority", () => {
  it("accepts a checksum-valid G-account issuer and rejects checksum lookalikes", () => {
    const prepared = prepare({
      walletId: "wallet-a",
      amount: "1",
      assetCode: "USDC",
      assetIssuer: ISSUER_A
    });

    expect(prepared.assetIssuer).toBe(ISSUER_A);
    expect(() =>
      prepare({
        walletId: "wallet-a",
        amount: "1",
        assetCode: "USDC",
        assetIssuer: ISSUER_BAD_CHECKSUM
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "assetIssuer" }
      })
    );
  });

  it.each([
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "GISSUER1"
  ])("rejects non-StrKey issuer %j", (assetIssuer) => {
    expect(() =>
      prepare({
        walletId: "wallet-a",
        amount: "1",
        assetCode: "USD",
        assetIssuer
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "assetIssuer" }
      })
    );
  });

  it("rejects non-string runtime memos instead of coercing them", () => {
    expect(() =>
      prepare({
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
  });

  it("enforces the 28-byte Stellar MEMO_TEXT limit using UTF-8 bytes", () => {
    expect(
      prepare({ walletId: "wallet-a", amount: "1", memo: "x".repeat(28) })
        .memo
    ).toBe("x".repeat(28));
    expect(
      prepare({ walletId: "wallet-a", amount: "1", memo: "🚀".repeat(7) })
        .memo
    ).toBe("🚀".repeat(7));

    expect(() =>
      prepare({ walletId: "wallet-a", amount: "1", memo: "x".repeat(29) })
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
      prepare({ walletId: "wallet-a", amount: "1", memo: "🚀".repeat(8) })
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
});
