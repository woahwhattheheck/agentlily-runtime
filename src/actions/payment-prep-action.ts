import { createHash } from "node:crypto";

import { RuntimeError } from "../errors/runtime-errors.js";
import { assertNonEmptyValue } from "../guards/runtime-guards.js";
import type { ToolDefinition, ToolInvocation } from "../tools/types.js";

const STROOPS_PER_UNIT = 10_000_000n;
const STROOPS_PER_UNIT_NUMBER = 10_000_000;
const MAX_STELLAR_AMOUNT_STROOPS = 9_223_372_036_854_775_807n;
const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/;
const STELLAR_ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const STELLAR_ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3;
const STELLAR_ACCOUNT_ID_DECODED_BYTES = 35;
const STELLAR_ACCOUNT_ID_PAYLOAD_BYTES = 33;
const MEMO_TEXT_MAX_BYTES = 28;

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

function decodeBase32(value: string): Uint8Array | undefined {
  let bitCount = 0;
  let bitBuffer = 0;
  const output: number[] = [];

  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      return undefined;
    }

    bitBuffer = (bitBuffer << 5) | digit;
    bitCount += 5;

    while (bitCount >= 8) {
      bitCount -= 8;
      output.push((bitBuffer >>> bitCount) & 0xff);
      bitBuffer = bitCount === 0 ? 0 : bitBuffer & ((1 << bitCount) - 1);
    }
  }

  // Stellar StrKeys are canonical unpadded base32. Any residual non-zero bits
  // would represent a non-canonical alternate spelling of the same bytes.
  if (bitCount !== 0 && bitBuffer !== 0) {
    return undefined;
  }

  return Uint8Array.from(output);
}

function crc16Xmodem(bytes: Uint8Array): number {
  let checksum = 0;

  for (const byte of bytes) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum =
        (checksum & 0x8000) !== 0
          ? ((checksum << 1) ^ 0x1021) & 0xffff
          : (checksum << 1) & 0xffff;
    }
  }

  return checksum;
}

function isValidStellarAccountId(value: string): boolean {
  if (!STELLAR_ACCOUNT_ID_RE.test(value)) {
    return false;
  }

  const decoded = decodeBase32(value);
  if (
    decoded === undefined ||
    decoded.byteLength !== STELLAR_ACCOUNT_ID_DECODED_BYTES ||
    decoded[0] !== ED25519_PUBLIC_KEY_VERSION_BYTE
  ) {
    return false;
  }

  const checksumLow = decoded[STELLAR_ACCOUNT_ID_PAYLOAD_BYTES];
  const checksumHigh = decoded[STELLAR_ACCOUNT_ID_PAYLOAD_BYTES + 1];
  if (checksumLow === undefined || checksumHigh === undefined) {
    return false;
  }

  const expectedChecksum = checksumLow | (checksumHigh << 8);
  const actualChecksum = crc16Xmodem(
    decoded.subarray(0, STELLAR_ACCOUNT_ID_PAYLOAD_BYTES)
  );
  return actualChecksum === expectedChecksum;
}

function normalizeAssetIdentity(
  assetCodeValue: unknown,
  assetIssuerValue: unknown
): {
  assetCode: string;
  assetIssuer: string | undefined;
  canonicalAssetIdentity: string;
} {
  const assetCode = assetCodeValue ?? "XLM";
  if (typeof assetCode !== "string" || assetCode.trim().length === 0) {
    throw new RuntimeError(
      "INVALID_TASK",
      "assetCode must be a non-empty string.",
      { fieldName: "assetCode" }
    );
  }

  if (!STELLAR_ASSET_CODE_RE.test(assetCode)) {
    throw new RuntimeError(
      "INVALID_TASK",
      "assetCode must contain 1 to 12 ASCII letters or digits.",
      { fieldName: "assetCode" }
    );
  }

  const assetIssuer = assetIssuerValue ?? undefined;
  if (assetCode === "XLM") {
    if (assetIssuer !== undefined) {
      throw new RuntimeError(
        "INVALID_TASK",
        "assetIssuer must be omitted for native XLM.",
        { fieldName: "assetIssuer" }
      );
    }

    return {
      assetCode,
      assetIssuer: undefined,
      canonicalAssetIdentity: assetCode
    };
  }

  if (typeof assetIssuer !== "string" || assetIssuer.trim().length === 0) {
    throw new RuntimeError(
      "INVALID_TASK",
      "assetIssuer must be a non-empty string for non-native assets.",
      { fieldName: "assetIssuer" }
    );
  }
  if (!isValidStellarAccountId(assetIssuer)) {
    throw new RuntimeError(
      "INVALID_TASK",
      "assetIssuer must be a valid Stellar G-account ID.",
      { fieldName: "assetIssuer" }
    );
  }

  return {
    assetCode,
    assetIssuer,
    canonicalAssetIdentity: `${assetCode}:${assetIssuer}`
  };
}

function normalizeMemo(memo: unknown): string | undefined {
  if (memo === undefined) {
    return undefined;
  }
  if (typeof memo !== "string") {
    throw new RuntimeError("INVALID_TASK", "memo must be a string.", {
      fieldName: "memo"
    });
  }

  const memoBytes = Buffer.byteLength(memo, "utf8");
  if (memoBytes > MEMO_TEXT_MAX_BYTES) {
    throw new RuntimeError(
      "INVALID_TASK",
      `memo must be at most ${MEMO_TEXT_MAX_BYTES} UTF-8 bytes.`,
      { fieldName: "memo", memoBytes, maxMemoBytes: MEMO_TEXT_MAX_BYTES }
    );
  }
  return memo;
}

function createTransactionStubId(input: {
  taskId: string;
  walletId: string;
  recipientId: string | undefined;
  canonicalAssetIdentity: string;
  amountStroops: bigint;
  memo: string | undefined;
}): string {
  // Metadata is intentionally excluded: it is audit context rather than part of
  // the Stellar payment intent. Amount identity is expressed in stroops so
  // equivalent spellings such as "1", "1.0", and 1 share one idempotency key.
  // Native XLM keeps its historical "XLM" identity field so existing XLM stub
  // IDs stay stable; issued assets use "code:issuer" to bind the full identity.
  const canonicalIntent = JSON.stringify([
    input.taskId,
    input.walletId,
    input.recipientId ?? null,
    input.canonicalAssetIdentity,
    input.amountStroops.toString(),
    input.memo ?? null
  ]);
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

      const assetIdentity = normalizeAssetIdentity(
        payload.assetCode,
        payload.assetIssuer
      );
      const memo = normalizeMemo(payload.memo);

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
        canonicalAssetIdentity: assetIdentity.canonicalAssetIdentity,
        amountStroops: normalizedAmount.stroops,
        memo
      });

      return {
        status: "prepared",
        walletId: payload.walletId,
        amount: amountStr,
        recipientId: payload.recipientId,
        assetCode: assetIdentity.assetCode,
        assetIssuer: assetIdentity.assetIssuer,
        memo,
        preparedAt,
        transactionStubId,
        isSimulated: true,
        metadata: payload.metadata
      };
    }
  };
}
