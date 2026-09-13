import { describe, expect, it } from "vitest";
import {
  createPaymentPrepTool,
  type PaymentPrepPayload
} from "../../src/actions/payment-prep-action.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

const context = {
  taskId: "recipient-id-validation",
  now: "2026-09-13T06:15:00.000Z"
} as unknown as RuntimeContext;

describe("payment preparation recipientId runtime validation", () => {
  it.each(["", "   ", null, 0, false, ["GRECIPIENT"], { id: "GRECIPIENT" }])(
    "rejects malformed explicit recipientId %j",
    (recipientId) => {
      const tool = createPaymentPrepTool();
      const payload = {
        walletId: "GWALLET123",
        amount: "1",
        recipientId
      } as unknown as PaymentPrepPayload;

      expect(() => tool.execute({ payload, context })).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { fieldName: "recipientId" }
        })
      );
    }
  );

  it("preserves omission and a valid explicit recipientId", () => {
    const tool = createPaymentPrepTool();

    const omitted = tool.execute({
      payload: { walletId: "GWALLET123", amount: "1" },
      context
    });
    const explicit = tool.execute({
      payload: {
        walletId: "GWALLET123",
        amount: "1",
        recipientId: "GRECIPIENT123"
      },
      context
    });

    expect(omitted.recipientId).toBeUndefined();
    expect(explicit.recipientId).toBe("GRECIPIENT123");
  });
});
