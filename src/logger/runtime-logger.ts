export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogger {
  readonly level?: RuntimeLogLevel;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  debug(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

const LOG_LEVEL_PRIORITY: Record<RuntimeLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function shouldLog(
  level: RuntimeLogLevel,
  minimumLevel: RuntimeLogLevel
): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minimumLevel];
}

export interface ConsoleRuntimeLoggerOptions {
  level?: RuntimeLogLevel;
  redactKeys?: RegExp;
}

const DEFAULT_REDACT_KEYS = /(secret|token|password|api.?key|authorization)/i;
const CIRCULAR_METADATA_SENTINEL = "[Circular]";
const ACCESSOR_METADATA_SENTINEL = "[Accessor]";
const UNINSPECTABLE_METADATA_SENTINEL = "[Uninspectable]";

function matchesRedactKey(key: string, redactKeys: RegExp): boolean {
  // `RegExp.test()` mutates lastIndex for global/sticky regexes. Treat the
  // public redactKeys option as a reusable predicate instead of allowing one
  // matching key to change whether the next key is redacted.
  const originalLastIndex = redactKeys.lastIndex;
  redactKeys.lastIndex = 0;
  try {
    return redactKeys.test(key);
  } finally {
    redactKeys.lastIndex = originalLastIndex;
  }
}

function redactDescriptorValue(
  key: string,
  descriptor: PropertyDescriptor,
  redactKeys: RegExp,
  ancestors: WeakSet<object>
): unknown {
  if (matchesRedactKey(key, redactKeys)) {
    return "[REDACTED]";
  }

  // Logging must remain observational. Reading an accessor can execute
  // arbitrary caller code or throw after the operation being logged has
  // already completed, so preserve the key without invoking the accessor.
  if (!("value" in descriptor)) {
    return ACCESSOR_METADATA_SENTINEL;
  }

  return redactValue(descriptor.value, redactKeys, ancestors);
}

function redactValue(
  value: unknown,
  redactKeys: RegExp,
  ancestors: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (ancestors.has(value)) {
    return CIRCULAR_METADATA_SENTINEL;
  }

  ancestors.add(value);
  try {
    let isArray: boolean;
    let descriptors: PropertyDescriptorMap;
    try {
      // Descriptors let us inspect enumerable data properties without invoking
      // getters. A hostile/revoked Proxy may still reject introspection; keep
      // that diagnostic value contained rather than failing the log call.
      isArray = Array.isArray(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return UNINSPECTABLE_METADATA_SENTINEL;
    }

    if (isArray) {
      const lengthValue = descriptors.length?.value;
      const length =
        typeof lengthValue === "number" && Number.isSafeInteger(lengthValue)
          ? lengthValue
          : 0;
      const result: unknown[] = new Array(Math.max(0, length));

      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length" || !descriptor.enumerable) {
          continue;
        }

        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= result.length ||
          String(index) !== key
        ) {
          continue;
        }

        result[index] = redactDescriptorValue(
          key,
          descriptor,
          redactKeys,
          ancestors
        );
      }

      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) {
        continue;
      }

      result[key] = redactDescriptorValue(
        key,
        descriptor,
        redactKeys,
        ancestors
      );
    }
    return result;
  } finally {
    // Track only the active traversal path. The same object may be referenced
    // from multiple non-cyclic branches and should serialize normally each time.
    ancestors.delete(value);
  }
}

export class ConsoleRuntimeLogger implements RuntimeLogger {
  public readonly level: RuntimeLogLevel;
  private readonly redactKeys: RegExp;

  public constructor(options: ConsoleRuntimeLoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
  }

  public info(message: string, metadata?: Record<string, unknown>): void {
    this.emit("info", message, metadata);
  }

  public warn(message: string, metadata?: Record<string, unknown>): void {
    this.emit("warn", message, metadata);
  }

  public debug(message: string, metadata?: Record<string, unknown>): void {
    this.emit("debug", message, metadata);
  }

  public error(message: string, metadata?: Record<string, unknown>): void {
    this.emit("error", message, metadata);
  }

  private emit(
    level: RuntimeLogLevel,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const prepared = this.prepareMetadata(metadata);
    switch (level) {
      case "debug":
        console.debug(message, prepared);
        break;
      case "info":
        console.info(message, prepared);
        break;
      case "warn":
        console.warn(message, prepared);
        break;
      case "error":
        console.error(message, prepared);
        break;
    }
  }

  private shouldLog(level: RuntimeLogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private prepareMetadata(
    metadata?: Record<string, unknown>
  ): Record<string, unknown> {
    const redacted = redactValue(metadata ?? {}, this.redactKeys);
    return redacted !== null &&
      typeof redacted === "object" &&
      !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>)
      : { metadata: redacted };
  }
}

export interface InMemoryRuntimeLoggerOptions {
  /** Maximum number of entries to retain. Oldest entries are evicted first. Defaults to 5 000. Use 0 for unbounded retention. */
  maxEntries?: number;
  /** Minimum severity level to record. Entries below this level are silently discarded. When omitted, all levels are recorded. */
  level?: RuntimeLogLevel;
  /** Regex matched against metadata keys; matching values are replaced with `"[REDACTED]"`. Defaults to `DEFAULT_REDACT_KEYS`. Pass a regex that matches nothing (e.g. `/$^/`) to disable redaction. */
  redactKeys?: RegExp;
}

export interface InMemoryLogEntry {
  level: RuntimeLogLevel;
  message: string;
  metadata: Record<string, unknown> | undefined;
}

export class InMemoryRuntimeLogger implements RuntimeLogger {
  public readonly entries: InMemoryLogEntry[] = [];
  public readonly level: RuntimeLogLevel;
  private readonly maxEntries: number;
  private readonly minimumLevel: RuntimeLogLevel;
  private readonly redactKeys: RegExp;

  public constructor(options: InMemoryRuntimeLoggerOptions = {}) {
    const maxEntries = options.maxEntries ?? 5_000;
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError("maxEntries must be a non-negative integer.");
    }

    this.maxEntries = maxEntries;
    this.level = options.level ?? "debug";
    this.minimumLevel = this.level;
    this.redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
  }

  public info(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      this.appendEntry("info", message, metadata);
    }
  }

  public warn(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      this.appendEntry("warn", message, metadata);
    }
  }

  public debug(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      this.appendEntry("debug", message, metadata);
    }
  }

  public error(message: string, metadata?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      this.appendEntry("error", message, metadata);
    }
  }

  public clear(): void {
    this.entries.length = 0;
  }

  public size(): number {
    return this.entries.length;
  }

  private shouldLog(level: RuntimeLogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minimumLevel];
  }

  private appendEntry(
    level: RuntimeLogLevel,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }
    if (this.maxEntries > 0 && this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }
    const redacted = metadata ? redactValue(metadata, this.redactKeys) : undefined;
    const redactedMetadata =
      redacted !== undefined &&
      redacted !== null &&
      typeof redacted === "object" &&
      !Array.isArray(redacted)
        ? (redacted as Record<string, unknown>)
        : redacted === undefined
          ? undefined
          : { metadata: redacted };
    this.entries.push({ level, message, metadata: redactedMetadata });
  }
}
