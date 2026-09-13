export type RuntimeAuditLedgerErrorCode =
  | "AUDIT_ALREADY_OPEN"
  | "AUDIT_CANONICALIZATION_FAILED"
  | "AUDIT_CORRUPTED"
  | "AUDIT_IO_FAILED"
  | "AUDIT_NON_REGULAR_FILE"
  | "AUDIT_RECORD_TOO_LARGE"
  | "AUDIT_UNHEALTHY";

export class RuntimeAuditLedgerError extends Error {
  public readonly code: RuntimeAuditLedgerErrorCode;

  public constructor(code: RuntimeAuditLedgerErrorCode, message: string) {
    super(message);
    this.name = "RuntimeAuditLedgerError";
    this.code = code;
  }
}
