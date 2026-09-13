import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RuntimeError } from "../errors/runtime-errors.js";
import {
  JsonFileToolApprovalStore as LegacyJsonFileToolApprovalStore,
  type JsonFileToolApprovalStoreOptions
} from "./json-file-tool-approval-store.js";
import type {
  ToolApprovalConsumeDecision,
  ToolApprovalConsumeRequest,
  ToolApprovalGrantRequest,
  ToolApprovalRecord,
  ToolApprovalStore
} from "./tool-approval-policy.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function unsafeAuthorityPath(
  requestedPath: string,
  authorityPath: string,
  reason: string
): RuntimeError {
  return new RuntimeError(
    "STORAGE_CORRUPTED",
    `Unsafe tool approval storage path at ${requestedPath}: ${reason}.`,
    { requestedPath, authorityPath }
  );
}

async function canonicalAuthorityPath(filePath: string): Promise<string> {
  const requestedPath = resolve(filePath);
  const requestedParent = dirname(requestedPath);
  await mkdir(requestedParent, { recursive: true });
  const canonicalParent = await realpath(requestedParent);
  return join(canonicalParent, basename(requestedPath));
}

async function assertSafeAuthorityFile(
  requestedPath: string,
  authorityPath: string
): Promise<void> {
  let stats;
  try {
    stats = await lstat(authorityPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw unsafeAuthorityPath(
      requestedPath,
      authorityPath,
      "the authority file must not be a symbolic link"
    );
  }
  if (!stats.isFile()) {
    throw unsafeAuthorityPath(
      requestedPath,
      authorityPath,
      "the authority path must be a regular file"
    );
  }
  if (stats.nlink !== 1) {
    throw unsafeAuthorityPath(
      requestedPath,
      authorityPath,
      "the authority file must have exactly one filesystem link"
    );
  }
}

/**
 * Public durable approval store with one canonical filesystem authority path.
 *
 * The underlying durable state machine retains its atomic compare-and-consume
 * behavior. This boundary canonicalizes the parent directory before the legacy
 * store derives its queue/lock/read/rename paths, rejects approval-file
 * symlinks, and rejects multiply-linked regular files. That prevents two
 * cooperating store instances from assigning different locks to one authority
 * inode or from splitting one grant into alias-specific copies.
 */
export class JsonFileToolApprovalStore implements ToolApprovalStore {
  private readonly filePath: string;
  private readonly resolvedFilePath: string;
  private readonly options: JsonFileToolApprovalStoreOptions;
  private authorityPathPromise: Promise<string> | undefined;
  private storePromise: Promise<LegacyJsonFileToolApprovalStore> | undefined;

  public constructor(
    filePath: string,
    options: JsonFileToolApprovalStoreOptions
  ) {
    // Preserve the existing constructor validation contract without performing
    // authority-bearing filesystem IO before the first async operation.
    new LegacyJsonFileToolApprovalStore(filePath, options);

    this.filePath = filePath;
    this.resolvedFilePath = resolve(filePath);
    this.options = {
      runtimeId: options.runtimeId,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.lockTimeoutMs === undefined
        ? {}
        : { lockTimeoutMs: options.lockTimeoutMs }),
      ...(options.lockRetryDelayMs === undefined
        ? {}
        : { lockRetryDelayMs: options.lockRetryDelayMs })
    };
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async approve(
    request: ToolApprovalGrantRequest
  ): Promise<ToolApprovalRecord> {
    return this.withStore((store) => store.approve(request));
  }

  public async revoke(approvalId: string): Promise<boolean> {
    return this.withStore((store) => store.revoke(approvalId));
  }

  public async get(
    approvalId: string
  ): Promise<ToolApprovalRecord | undefined> {
    return this.withStore((store) => store.get(approvalId));
  }

  public async consume(
    request: ToolApprovalConsumeRequest
  ): Promise<ToolApprovalConsumeDecision> {
    return this.withStore((store) => store.consume(request));
  }

  private getAuthorityPath(): Promise<string> {
    this.authorityPathPromise ??= canonicalAuthorityPath(this.resolvedFilePath);
    return this.authorityPathPromise;
  }

  private async getStore(
    authorityPath: string
  ): Promise<LegacyJsonFileToolApprovalStore> {
    this.storePromise ??= Promise.resolve(
      new LegacyJsonFileToolApprovalStore(authorityPath, this.options)
    );
    return this.storePromise;
  }

  private async withStore<T>(
    operation: (store: LegacyJsonFileToolApprovalStore) => Promise<T>
  ): Promise<T> {
    const authorityPath = await this.getAuthorityPath();
    await assertSafeAuthorityFile(this.filePath, authorityPath);
    const store = await this.getStore(authorityPath);
    return operation(store);
  }
}
