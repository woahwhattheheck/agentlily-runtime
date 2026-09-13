import { RuntimeAuditLedgerError } from "./audit-errors.js";

const MAX_CANONICAL_DEPTH = 12;
const MAX_STRING_BYTES = 16 * 1024;

export function canonicalAuditJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>()
): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RuntimeAuditLedgerError(
      "AUDIT_CANONICALIZATION_FAILED",
      "Audit value exceeds the maximum canonicalization depth."
    );
  }

  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_CANONICALIZATION_FAILED",
        "Audit string exceeds the maximum canonical size."
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_CANONICALIZATION_FAILED",
        "Audit numbers must be finite."
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new RuntimeAuditLedgerError(
      "AUDIT_CANONICALIZATION_FAILED",
      `Unsupported audit value type: ${typeof value}.`
    );
  }

  if (seen.has(value)) {
    throw new RuntimeAuditLedgerError(
      "AUDIT_CANONICALIZATION_FAILED",
      "Audit values must not contain cycles."
    );
  }
  seen.add(value);

  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_CANONICALIZATION_FAILED",
          "Audit arrays must use the ordinary Array prototype."
        );
      }

      const descriptors = Object.getOwnPropertyDescriptors(value);
      const allowedKeys = new Set<string>(["length"]);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          throw new RuntimeAuditLedgerError(
            "AUDIT_CANONICALIZATION_FAILED",
            "Audit arrays must be dense ordinary data arrays."
          );
        }
        items.push(canonicalAuditJson(descriptor.value, depth + 1, seen));
      }

      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowedKeys.has(key)) {
          throw new RuntimeAuditLedgerError(
            "AUDIT_CANONICALIZATION_FAILED",
            "Audit arrays must not contain symbol or extra properties."
          );
        }
      }
      return `[${items.join(",")}]`;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_CANONICALIZATION_FAILED",
        "Audit objects must use a plain or null prototype."
      );
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new RuntimeAuditLedgerError(
        "AUDIT_CANONICALIZATION_FAILED",
        "Audit objects must not contain symbol properties."
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields: string[] = [];
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new RuntimeAuditLedgerError(
          "AUDIT_CANONICALIZATION_FAILED",
          "Audit objects must contain only enumerable data properties."
        );
      }
      fields.push(
        `${JSON.stringify(key)}:${canonicalAuditJson(
          descriptor.value,
          depth + 1,
          seen
        )}`
      );
    }
    return `{${fields.join(",")}}`;
  } catch (error) {
    if (error instanceof RuntimeAuditLedgerError) {
      throw error;
    }
    throw new RuntimeAuditLedgerError(
      "AUDIT_CANONICALIZATION_FAILED",
      "Audit value could not be inspected safely."
    );
  } finally {
    seen.delete(value);
  }
}

export function exactAuditKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return (
    keys.length === target.length &&
    keys.every((key, index) => key === target[index])
  );
}

export function isPlainAuditRecord(
  value: unknown
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
