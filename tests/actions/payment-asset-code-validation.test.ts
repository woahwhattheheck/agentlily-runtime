import { describe, expect, it } from "vitest";
import {
  createPaymentPrepTool,
  type PaymentPrepPayload
} from "../../src/actions/payment-prep-action.js";
import type { RuntimeContext } from "../../src/runtime/context.js";

const context = {
  taskId: "asset-code-validation",
  now: "2026-09-13T04:20:00.000Z"
} as unknown as RuntimeContext;
const validIssuer =
  "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGF";

describe("payment preparation assetCode runtime validation", () => {
  it.each(["", "   ", 0, false, ["USDC"], { code: "USDC" }])(
    "rejects malformed runtime assetCode %j",
    (assetCode) => {
      const tool = createPaymentPrepTool();
      const payload = {
        walletId: "GWALLET123",
        amount: "1",
        assetCode
      } as unknown as PaymentPrepPayload;

      expect(() => tool.execute({ payload, context })).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { fieldName: "assetCode" }
        })
      );
    }
  );

  it("preserves the nullish XLM default and valid explicit issued assets", () => {
    const tool = createPaymentPrepTool();

    const omitted = tool.execute({
      payload: { walletId: "GWALLET123", amount: "1" },
      context
    });
    const runtimeNull = tool.execute({
      payload: {
        walletId: "GWALLET123",
        amount: "1",
        assetCode: null as unknown as string
      },
      context
    });
    const explicit = tool.execute({
      payload: {
        walletId: "GWALLET123",
        amount: "1",
        assetCode: "USDC",
        assetIssuer: validIssuer
      },
      context
    });

    expect(omitted.assetCode).toBe("XLM");
    expect(runtimeNull.assetCode).toBe("XLM");
    expect(explicit.assetCode).toBe("USDC");
    expect(explicit.assetIssuer).toBe(validIssuer);
  });
});
