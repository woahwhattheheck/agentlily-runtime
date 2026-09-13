import { createHash } from "node:crypto";

import { RuntimeError } from "../errors/runtime-errors.js";
import { assertNonEmptyValue } from "../guards/runtime-guards.js";
import type { ToolDefinition, ToolInvocation } from "../tools/types.js";

const STROOPS_PER_UNIT = 10_000_000n;
const STROOPS_PER_UNIT_NUMBER = 10_000_000;
const MAX_STELLAR_AMOUNT_STROOPS = 9_223_372_036_854_775_807n;
const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/;
const STELLAR_ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;

export interface PaymentPrepPayload {
  walletId: string;
  amount: string | number;
  recipientId?: string | undefined;
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  memo?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface PaymentPrepResult {
  status: "prepared";
  walletId: string;
  amount: string;
  recipientId?: string | undefined;
  assetCode: string;
  assetIssuer?: string | undefined;
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

function normalizeStellarAmount(amount: string | number): {
  amount: string;
  stroops: bigint;
} {
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

  return { amount: amountStr, stroops };
}

function createTransactionStubId(input: {
  taskId: string;
  walletId: string;
  recipientId: string | undefined;
  assetCode: string;
  assetIssuer: string | undefined;
  amountStroops: bigint;
  memo: string | undefined;
}): string {
  // Metadata is intentionally excluded: it is audit context rather than part of
  // the Stellar payment intent. Amount identity is expressed in stroops so
  // equivalent spellings such as "1", "1.0", and 1 share one idempotency key.
  // Keep native-XLM intent bytes backward compatible with the pre-issuer format;
  // issued assets append issuer identity so equal codes from different issuers
  // cannot collapse to the same transaction stub.
  const nativeIntent = [
    input.taskId,
    input.walletId,
    input.recipientId ?? null,
    input.assetCode,
    input.amountStroops.toString(),
    input.memo ?? null
  ];
  const canonicalIntent = JSON.stringify(
    input.assetIssuer === undefined
      ? nativeIntent
      : [...nativeIntent, input.assetIssuer]
  );
  const intentDigest = createHash("sha256")
    .update(canonicalIntent, "utf8")
    .digest("hex");

  return `stellar-stub-${input.taskId}-${input.walletId}-${intentDigest}`;
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
      if (payload.recipientId !== undefined) {
        assertNonEmptyValue(payload.recipientId, "recipientId");
      }
      const assetCode = payload.assetCode ?? "XLM";
      assertNonEmptyValue(assetCode, "assetCode");
      if (!STELLAR_ASSET_CODE_RE.test(assetCode)) {
        throw new RuntimeError(
          "INVALID_TASK",
          "assetCode must contain 1 to 12 alphanumeric characters.",
          { fieldName: "assetCode", assetCode }
        );
      }

      const assetIssuer = payload.assetIssuer;
      if (assetIssuer !== undefined) {
        assertNonEmptyValue(assetIssuer, "assetIssuer");
        if (assetIssuer !== assetIssuer.trim()) {
          throw new RuntimeError(
            "INVALID_TASK",
            "assetIssuer must not contain leading or trailing whitespace.",
            { fieldName: "assetIssuer" }
          );
        }
        if (assetCode === "XLM") {
          throw new RuntimeError(
            "INVALID_TASK",
            "assetIssuer must be omitted for native XLM.",
            { fieldName: "assetIssuer", assetCode }
          );
        }
      } else if (assetCode !== "XLM") {
        throw new RuntimeError(
          "INVALID_TASK",
          "assetIssuer must be specified for issued Stellar assets.",
          { fieldName: "assetIssuer", assetCode }
        );
      }

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

      const normalizedAmount = normalizeStellarAmount(amount);
      const amountStr = normalizedAmount.amount;

      const preparedAt = context.now || new Date().toISOString();
      const transactionStubId = createTransactionStubId({
        taskId: context.taskId,
        walletId: payload.walletId,
        recipientId: payload.recipientId,
        assetCode,
        assetIssuer,
        amountStroops: normalizedAmount.stroops,
        memo: payload.memo
      });

      return {
        status: "prepared",
        walletId: payload.walletId,
        amount: amountStr,
        recipientId: payload.recipientId,
        assetCode,
        assetIssuer,
        memo: payload.memo,
        preparedAt,
        transactionStubId,
        isSimulated: true,
        metadata: payload.metadata
      };
    }
  };
}
