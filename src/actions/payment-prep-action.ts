import { RuntimeError } from "../errors/runtime-errors.js";
import { assertNonEmptyValue } from "../guards/runtime-guards.js";
import type { ToolDefinition, ToolInvocation } from "../tools/types.js";

const STROOPS_PER_UNIT = 10_000_000n;
const STROOPS_PER_UNIT_NUMBER = 10_000_000;
const MAX_STELLAR_AMOUNT_STROOPS = 9_223_372_036_854_775_807n;
const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/;

export interface PaymentPrepPayload {
  walletId: string;
  amount: string | number;
  recipientId?: string | undefined;
  assetCode?: string | undefined;
  memo?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface PaymentPrepResult {
  status: "prepared";
  walletId: string;
  amount: string;
  recipientId?: string | undefined;
  assetCode: string;
  memo?: string | undefined;
  preparedAt: string;
  transactionStubId: string;
  isSimulated: true;
  metadata?: Record<string, unknown> | undefined;
}

export const PAYMENT_PREP_TOOL_NAME = "wallet.prepare_payment";

function invalidAmount(amount: unknown): never {
  throw new RuntimeError(
    "INVALID_TASK",
    "amount must be a positive Stellar decimal with at most 7 fractional digits.",
    { amount }
  );
}

function normalizeNumericAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return invalidAmount(amount);
  }

  // Fractional JSON numbers are only safe for payment preparation while their
  // exact Number value still resolves to an integer number of stroops. At high
  // magnitudes IEEE-754 spacing exceeds Stellar's 1e-7 unit, so String(amount)
  // can otherwise silently prepare a rounded value. Exact high-value amounts
  // remain available through the string input form.
  if (
    !Number.isInteger(amount) &&
    !Number.isSafeInteger(amount * STROOPS_PER_UNIT_NUMBER)
  ) {
    return invalidAmount(amount);
  }

  let amountStr = String(amount);
  if (/e/i.test(amountStr)) {
    // Small valid numeric amounts such as 1e-7 stringify in exponent notation,
    // which Stellar payment amounts do not use. Convert only when seven fixed
    // fractional digits can represent the same Number exactly.
    const fixed = amount.toFixed(7);
    if (Number(fixed) !== amount) {
      return invalidAmount(amount);
    }
    amountStr = fixed.replace(/\.?(?:0+)$/, "");
  }
  return amountStr;
}

function normalizeStellarAmount(amount: string | number): string {
  const amountStr =
    typeof amount === "number" ? normalizeNumericAmount(amount) : amount;
  const match = DECIMAL_AMOUNT_RE.exec(amountStr);
  if (match === null) {
    return invalidAmount(amount);
  }

  const [wholePart, fractionalPart = ""] = amountStr.split(".");
  const stroops =
    BigInt(wholePart) * STROOPS_PER_UNIT +
    BigInt(fractionalPart.padEnd(7, "0") || "0");
  if (stroops <= 0n || stroops > MAX_STELLAR_AMOUNT_STROOPS) {
    return invalidAmount(amount);
  }

  return amountStr;
}

export function createPaymentPrepTool(): ToolDefinition<
  PaymentPrepPayload,
  PaymentPrepResult
> {
  return {
    name: PAYMENT_PREP_TOOL_NAME,
    description:
      "Prepares and validates payment context and transaction stub for AgentLily wallet tasks without performing live Stellar network calls.",
    execute({
      payload,
      context
    }: ToolInvocation<PaymentPrepPayload>): PaymentPrepResult {
      assertNonEmptyValue(payload.walletId, "walletId");
      const assetCode = payload.assetCode ?? "XLM";
      assertNonEmptyValue(assetCode, "assetCode");

      const amount = payload.amount as unknown;
      if (
        amount === undefined ||
        amount === null ||
        (typeof amount === "string" && amount.trim().length === 0)
      ) {
        throw new RuntimeError("INVALID_TASK", "amount must be specified.", {
          fieldName: "amount"
        });
      }

      if (typeof amount !== "string" && typeof amount !== "number") {
        throw new RuntimeError(
          "INVALID_TASK",
          "amount must be a string or number.",
          { fieldName: "amount" }
        );
      }

      const amountStr = normalizeStellarAmount(amount);

      const preparedAt = context.now || new Date().toISOString();
      const transactionStubId = `stellar-stub-${context.taskId}-${payload.walletId}`;

      return {
        status: "prepared",
        walletId: payload.walletId,
        amount: amountStr,
        recipientId: payload.recipientId,
        assetCode,
        memo: payload.memo,
        preparedAt,
        transactionStubId,
        isSimulated: true,
        metadata: payload.metadata
      };
    }
  };
}
