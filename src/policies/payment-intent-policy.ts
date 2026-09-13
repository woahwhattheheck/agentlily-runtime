import { types as utilTypes } from "node:util";

import {
  PAYMENT_PREP_TOOL_NAME,
  createPaymentPrepTool,
  type PaymentPrepPayload,
  type PaymentPrepResult
} from "../actions/payment-prep-action.js";
import type {
  ToolPolicy,
  ToolPolicyDecision,
  ToolPolicyRequest
} from "./tool-policy.js";

const STROOPS_PER_UNIT = 10_000_000n;
const MAX_STELLAR_AMOUNT_STROOPS = 9_223_372_036_854_775_807n;
const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/;
const STELLAR_ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const STELLAR_ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/;
const PAYMENT_DATA_FIELDS = [
  "walletId",
  "amount",
  "recipientId",
  "assetCode",
  "assetIssuer",
  "memo"
] as const;

export interface StellarPaymentAssetPolicy {
  assetCode: string;
  assetIssuer?: string | undefined;
}

export interface StellarPaymentWalletPolicy {
  walletId: string;
  maxAmount?: string | undefined;
  allowedRecipientIds?: Iterable<string> | undefined;
  allowedAssets?: Iterable<StellarPaymentAssetPolicy> | undefined;
  requireRecipient?: boolean | undefined;
  requireMemo?: boolean | undefined;
}

export interface StellarPaymentIntentPolicyOptions {
  wallets: Iterable<StellarPaymentWalletPolicy>;
}

interface CompiledWalletPolicy {
  maxAmountStroops: bigint | undefined;
  allowedRecipientIds: ReadonlySet<string> | undefined;
  allowedAssets: ReadonlySet<string> | undefined;
  requireRecipient: boolean;
  requireMemo: boolean;
}

interface DataField {
  ok: boolean;
  value?: unknown;
}

type PlainDataSnapshot =
  | { ok: true; value: unknown }
  | { ok: false };

interface FieldReplacement {
  key: string;
  descriptor: PropertyDescriptor;
  value: unknown;
}

function denial(reason: string): ToolPolicyDecision {
  return { allowed: false, reason };
}

function requireConfigString(value: unknown, fieldName: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${fieldName} must be a non-empty trimmed string.`);
  }
  return value;
}

function parseExactStroops(value: string): bigint | undefined {
  if (!DECIMAL_AMOUNT_RE.test(value)) {
    return undefined;
  }

  const [wholePart, fractionalPart = ""] = value.split(".");
  if (wholePart === undefined) {
    return undefined;
  }
  const stroops =
    BigInt(wholePart) * STROOPS_PER_UNIT +
    BigInt(fractionalPart.padEnd(7, "0") || "0");
  if (stroops <= 0n || stroops > MAX_STELLAR_AMOUNT_STROOPS) {
    return undefined;
  }
  return stroops;
}

function parseConfiguredMaxAmount(
  value: string | undefined
): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  const stroops = parseExactStroops(value);
  if (stroops === undefined) {
    throw new RangeError(
      "maxAmount must be a positive Stellar decimal with at most 7 fractional digits."
    );
  }
  return stroops;
}

function assetIdentity(
  assetCode: string,
  assetIssuer: string | undefined
): string {
  return `${assetCode}\u0000${assetIssuer ?? ""}`;
}

function compileAssetAllowlist(
  assets: Iterable<StellarPaymentAssetPolicy> | undefined
): ReadonlySet<string> | undefined {
  if (assets === undefined) {
    return undefined;
  }

  const snapshot = new Set<string>();
  for (const asset of assets) {
    if (asset === null || typeof asset !== "object") {
      throw new TypeError(
        "allowedAssets entries must be asset policy objects."
      );
    }
    const assetCode = requireConfigString(asset.assetCode, "assetCode");
    if (!STELLAR_ASSET_CODE_RE.test(assetCode)) {
      throw new RangeError(
        "assetCode must contain 1 to 12 alphanumeric characters."
      );
    }

    let assetIssuer: string | undefined;
    if (asset.assetIssuer !== undefined) {
      assetIssuer = requireConfigString(asset.assetIssuer, "assetIssuer");
      if (!STELLAR_ACCOUNT_ID_RE.test(assetIssuer)) {
        throw new RangeError(
          "assetIssuer must have Stellar G-account ID syntax."
        );
      }
    }

    if (assetCode === "XLM" && assetIssuer !== undefined) {
      throw new RangeError(
        "Native XLM policy entries must not specify an issuer."
      );
    }
    if (assetCode !== "XLM" && assetIssuer === undefined) {
      throw new RangeError(
        "Issued asset policy entries must specify an issuer."
      );
    }
    snapshot.add(assetIdentity(assetCode, assetIssuer));
  }
  return snapshot;
}

function compileRecipientAllowlist(
  recipientIds: Iterable<string> | undefined
): ReadonlySet<string> | undefined {
  if (recipientIds === undefined) {
    return undefined;
  }
  if (typeof recipientIds === "string") {
    throw new TypeError(
      "allowedRecipientIds must be an iterable of recipient IDs, not a string."
    );
  }
  const snapshot = new Set<string>();
  for (const recipientId of recipientIds) {
    snapshot.add(requireConfigString(recipientId, "recipientId"));
  }
  return snapshot;
}

function readOwnDataField(value: object, fieldName: string): DataField {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, fieldName);
    if (descriptor === undefined) {
      return { ok: true, value: undefined };
    }
    if (!("value" in descriptor)) {
      return { ok: false };
    }
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

/**
 * Copy one approval-digest-compatible data graph into immutable plain data.
 *
 * ToolApprovalPolicy binds enumerable own data properties on plain objects and
 * dense arrays. Mirroring that domain here means the payment policy can make
 * the exact graph immutable without changing its digest. Proxies, accessors,
 * symbols, exotic objects, cycles, and shared object references are rejected
 * rather than partially copied.
 */
function snapshotPlainData(
  value: unknown,
  visited: Set<object>
): PlainDataSnapshot {
  if (value === null) {
    return { ok: true, value: null };
  }

  switch (typeof value) {
    case "string":
    case "boolean":
    case "undefined":
    case "bigint":
      return { ok: true, value };
    case "number":
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false };
    case "object":
      break;
    default:
      return { ok: false };
  }

  try {
    if (utilTypes.isProxy(value)) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }

  if (visited.has(value)) {
    return { ok: false };
  }
  visited.add(value);

  if (Array.isArray(value)) {
    let ownKeys: (string | symbol)[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      return { ok: false };
    }

    for (const key of ownKeys) {
      if (typeof key === "symbol") {
        return { ok: false };
      }
      if (key === "length") {
        continue;
      }
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        String(index) !== key ||
        index >= value.length
      ) {
        return { ok: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return { ok: false };
      }
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return { ok: false };
      }
      const item = snapshotPlainData(descriptor.value, visited);
      if (!item.ok) {
        return item;
      }
      snapshot.push(item.value);
    }
    return { ok: true, value: Object.freeze(snapshot) };
  }

  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return { ok: false };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false };
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    return { ok: false };
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return { ok: false };
    }
    const item = snapshotPlainData(descriptor.value, visited);
    if (!item.ok) {
      return item;
    }
    Object.defineProperty(snapshot, key, {
      value: item.value,
      writable: false,
      enumerable: true,
      configurable: false
    });
  }
  return { ok: true, value: Object.freeze(snapshot) };
}

function bindAuthorizedPaymentPayload(
  original: unknown,
  authorized: PaymentPrepPayload
): boolean {
  if (
    original === null ||
    typeof original !== "object" ||
    Array.isArray(original)
  ) {
    return false;
  }

  let prototype: object | null;
  try {
    if (utilTypes.isProxy(original)) {
      return false;
    }
    prototype = Object.getPrototypeOf(original);
  } catch {
    return false;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  for (const fieldName of PAYMENT_DATA_FIELDS) {
    const field = readOwnDataField(original, fieldName);
    if (!field.ok || field.value !== authorized[fieldName]) {
      return false;
    }
  }

  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(original);
  } catch {
    return false;
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    return false;
  }

  const replacements: FieldReplacement[] = [];
  const visited = new Set<object>([original]);
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return false;
    }
    const snapshot = snapshotPlainData(descriptor.value, visited);
    if (!snapshot.ok) {
      return false;
    }
    if (
      !Object.is(snapshot.value, descriptor.value) &&
      descriptor.configurable !== true &&
      descriptor.writable !== true
    ) {
      return false;
    }
    replacements.push({ key, descriptor, value: snapshot.value });
  }

  // Nulling the root prototype blocks later Object.prototype pollution without
  // synthesizing hidden optional fields. That preserves the exact own-key shape
  // and therefore the digest of an approval granted before policy evaluation.
  if (prototype !== null && !Object.isExtensible(original)) {
    return false;
  }

  try {
    if (prototype !== null) {
      Object.setPrototypeOf(original, null);
    }
    for (const replacement of replacements) {
      if (Object.is(replacement.value, replacement.descriptor.value)) {
        continue;
      }
      Object.defineProperty(original, replacement.key, {
        ...replacement.descriptor,
        value: replacement.value
      });
    }
    Object.freeze(original);
    return true;
  } catch {
    return false;
  }
}

function snapshotPaymentPayload(
  payload: unknown
): PaymentPrepPayload | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    utilTypes.isProxy(payload)
  ) {
    return undefined;
  }

  try {
    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const fields = [
    ...PAYMENT_DATA_FIELDS,
    "metadata"
  ] as const;
  const values = new Map<(typeof fields)[number], unknown>();
  for (const fieldName of fields) {
    const field = readOwnDataField(payload, fieldName);
    if (!field.ok) {
      return undefined;
    }
    values.set(fieldName, field.value);
  }

  const walletId = values.get("walletId");
  const amount = values.get("amount");
  const recipientId = values.get("recipientId");
  const assetCode = values.get("assetCode");
  const assetIssuer = values.get("assetIssuer");
  const memo = values.get("memo");

  if (
    typeof walletId !== "string" ||
    (typeof amount !== "string" && typeof amount !== "number") ||
    (recipientId !== undefined && typeof recipientId !== "string") ||
    (assetCode !== undefined && typeof assetCode !== "string") ||
    (assetIssuer !== undefined && typeof assetIssuer !== "string") ||
    (memo !== undefined && typeof memo !== "string")
  ) {
    return undefined;
  }

  return {
    walletId,
    amount,
    recipientId,
    assetCode,
    assetIssuer,
    memo
  };
}

/**
 * Controller-side authorization for the simulated wallet.prepare_payment tool.
 * Non-payment tools pass through so this policy can be combined with a generic
 * tool allowlist using AllOfToolPolicy.
 */
export class StellarPaymentIntentPolicy implements ToolPolicy {
  private readonly walletPolicies: ReadonlyMap<string, CompiledWalletPolicy>;
  private readonly paymentPrepTool = createPaymentPrepTool();

  public constructor(options: StellarPaymentIntentPolicyOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Payment policy options are required.");
    }

    const walletPolicies = new Map<string, CompiledWalletPolicy>();
    for (const rule of options.wallets) {
      if (rule === null || typeof rule !== "object") {
        throw new TypeError("wallets entries must be wallet policy objects.");
      }
      const walletId = requireConfigString(rule.walletId, "walletId");
      if (walletPolicies.has(walletId)) {
        throw new RangeError(
          `Duplicate payment policy for wallet "${walletId}".`
        );
      }
      if (
        rule.requireRecipient !== undefined &&
        typeof rule.requireRecipient !== "boolean"
      ) {
        throw new TypeError(
          "requireRecipient must be a boolean when provided."
        );
      }
      if (
        rule.requireMemo !== undefined &&
        typeof rule.requireMemo !== "boolean"
      ) {
        throw new TypeError("requireMemo must be a boolean when provided.");
      }

      walletPolicies.set(walletId, {
        maxAmountStroops: parseConfiguredMaxAmount(rule.maxAmount),
        allowedRecipientIds: compileRecipientAllowlist(
          rule.allowedRecipientIds
        ),
        allowedAssets: compileAssetAllowlist(rule.allowedAssets),
        requireRecipient: rule.requireRecipient ?? false,
        requireMemo: rule.requireMemo ?? false
      });
    }
    this.walletPolicies = walletPolicies;
  }

  public async evaluate(
    request: ToolPolicyRequest
  ): Promise<ToolPolicyDecision> {
    if (request.toolName !== PAYMENT_PREP_TOOL_NAME) {
      return { allowed: true };
    }

    const payload = snapshotPaymentPayload(request.payload);
    if (payload === undefined) {
      return denial("Payment policy requires a plain data payload.");
    }

    let prepared: PaymentPrepResult;
    try {
      prepared = await this.paymentPrepTool.execute({
        payload,
        context: request.context
      });
    } catch {
      return denial("Payment intent is invalid.");
    }

    const rule = this.walletPolicies.get(prepared.walletId);
    if (rule === undefined) {
      return denial("Wallet is not authorized for payment preparation.");
    }

    if (rule.maxAmountStroops !== undefined) {
      const amountStroops = parseExactStroops(prepared.amount);
      if (amountStroops === undefined) {
        return denial("Payment amount cannot be evaluated safely by policy.");
      }
      if (amountStroops > rule.maxAmountStroops) {
        return denial("Payment amount exceeds the wallet policy limit.");
      }
    }

    if (rule.requireRecipient && prepared.recipientId === undefined) {
      return denial("Payment policy requires an explicit recipient.");
    }
    if (
      rule.allowedRecipientIds !== undefined &&
      (prepared.recipientId === undefined ||
        !rule.allowedRecipientIds.has(prepared.recipientId))
    ) {
      return denial("Payment recipient is not authorized by wallet policy.");
    }

    if (
      rule.allowedAssets !== undefined &&
      !rule.allowedAssets.has(
        assetIdentity(prepared.assetCode, prepared.assetIssuer)
      )
    ) {
      return denial("Payment asset is not authorized by wallet policy.");
    }

    if (
      rule.requireMemo &&
      (prepared.memo === undefined || prepared.memo.length === 0)
    ) {
      return denial("Payment policy requires a non-empty memo.");
    }

    // Policy evaluation crosses an await boundary before any later composed
    // approval and before the executor invokes the tool. Re-read the authorized
    // payment fields, preserve the payload's exact own-key digest shape, and
    // replace its entire plain-data graph with immutable snapshots. This binds
    // both payment identity and audit/extension context through those gaps.
    if (!bindAuthorizedPaymentPayload(request.payload, payload)) {
      return denial("Payment payload changed during policy evaluation.");
    }

    return { allowed: true };
  }
}
