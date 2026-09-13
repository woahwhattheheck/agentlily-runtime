import { describe, expect, it } from "vitest";
import {
  createPaymentPrepTool,
  type PaymentPrepPayload,
  type PaymentPrepResult
} from "../../src/actions/payment-prep-action.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

const context = {
  taskId: "payment-numeric-precision",
  now: "2026-09-13T04:35:00.000Z"
} as unknown as RuntimeContext;

function prepare(amount: PaymentPrepPayload["amount"]): PaymentPrepResult {
  return createPaymentPrepTool().execute({
    payload: { walletId: "GWALLET123", amount },
    context
  }) as PaymentPrepResult;
}

describe("payment preparation numeric stroop precision", () => {
  it.each([1_000_000_000.1, 922337203685.4775807])(
    "rejects fractional numeric amount %s when stroops are not a safe integer",
    (amount) => {
      expect(Number.isInteger(amount)).toBe(false);
      expect(Number.isSafeInteger(amount * 10_000_000)).toBe(false);
      expect(() => prepare(amount)).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { amount }
        })
      );
    }
  );

  it("keeps accepting a fractional numeric amount whose stroop count is exact", () => {
    const amount = 900_000_000.1;

    expect(Number.isSafeInteger(amount * 10_000_000)).toBe(true);
    expect(prepare(amount).amount).toBe("900000000.1");
  });

  it("keeps accepting large whole-unit numeric amounts", () => {
    expect(prepare(922_337_203_685).amount).toBe("922337203685");
  });

  it("keeps the exact full-range fractional value available as a string", () => {
    expect(prepare("922337203685.4775807").amount).toBe(
      "922337203685.4775807"
    );
  });

  it("keeps accepting the smallest numeric stroop", () => {
    expect(prepare(1e-7).amount).toBe("0.0000001");
  });
});
