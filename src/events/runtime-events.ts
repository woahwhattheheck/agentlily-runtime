export interface RuntimeEventMap {
  "runtime.internal.error": {
    eventName: keyof RuntimeEventMap;
    errorMessage: string;
    occurredAt: string;
  };
  "runtime.started": { runtimeId: string; occurredAt: string };
  "runtime.stopped": {
    runtimeId: string;
    occurredAt: string;
    strandedTaskIds?: string[];
    drainDurationMs?: number;
  };
  "runtime.task.received": {
    runtimeId: string;
    taskId: string;
    agentId: string;
  };
  "runtime.task.completed": {
    runtimeId: string;
    taskId: string;
    agentId: string;
    toolName: string;
    durationMs: number;
  };
  "runtime.task.failed": {
    runtimeId: string;
    taskId: string;
    agentId: string;
    reason: string;
  };
  "runtime.tool.invoked": {
    runtimeId: string;
    taskId: string;
    agentId: string;
    toolName: string;
    invokedAt: string;
  };
  "runtime.tool.denied": {
    runtimeId: string;
    taskId: string;
    agentId: string;
    toolName: string;
    reason: string;
    deniedAt: string;
  };
}

export type RuntimeEventName = keyof RuntimeEventMap;

export interface RuntimeEvent<
  TName extends RuntimeEventName = RuntimeEventName
> {
  name: TName;
  payload: RuntimeEventMap[TName];
}

export type RuntimeEventListener<TName extends RuntimeEventName> = (
  event: RuntimeEvent<TName>
) => void;

export interface RuntimeEventBusOptions {
  /** Maximum listener registrations allowed per event name. Defaults to 100. */
  maxListeners?: number;
  /** Optional handler invoked whenever a listener throws or rejects. */
  onListenerError?: (error: unknown) => void;
}

export const DEFAULT_MAX_LISTENERS = 100;

export class RuntimeEventListenerLimitError extends Error {
  public readonly eventName: RuntimeEventName;
  public readonly maxListeners: number;

  public constructor(eventName: RuntimeEventName, maxListeners: number) {
    super(
      `Cannot add listener for "${eventName}": max listener count (${maxListeners}) exceeded.`
    );
    this.name = "RuntimeEventListenerLimitError";
    this.eventName = eventName;
    this.maxListeners = maxListeners;
  }
}

type Listener = RuntimeEventListener<RuntimeEventName>;
type OnceListener = Listener & { originalListener?: Listener };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function listenerErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return message;
      }
    } catch {
      return "Unknown listener failure.";
    }
  }

  try {
    return String(error);
  } catch {
    return "Unknown listener failure.";
  }
}

export class RuntimeEventBus {
  private readonly listeners = new Map<RuntimeEventName, Set<Listener>>();
  private readonly maxListeners: number;
  private readonly onListenerError: ((error: unknown) => void) | undefined;
  private isEmittingInternalError = false;

  public constructor(
    options?: number | RuntimeEventBusOptions | ((error: unknown) => void)
  ) {
    const resolved: RuntimeEventBusOptions =
      typeof options === "number"
        ? { maxListeners: options }
        : typeof options === "function"
          ? { onListenerError: options }
          : (options ?? {});

    if (
      resolved.maxListeners !== undefined &&
      (!Number.isInteger(resolved.maxListeners) || resolved.maxListeners < 1)
    ) {
      throw new RangeError("maxListeners must be a positive integer.");
    }

    this.maxListeners = resolved.maxListeners ?? DEFAULT_MAX_LISTENERS;
    this.onListenerError = resolved.onListenerError;
  }

  public on<TName extends RuntimeEventName>(
    eventName: TName,
    listener: RuntimeEventListener<TName>
  ): () => void {
    const listenerSet = this.getOrCreateListenerSet(eventName);
    const stored = listener as Listener;

    if (listenerSet.has(stored)) {
      return () => undefined;
    }

    if (listenerSet.size >= this.maxListeners) {
      throw new RuntimeEventListenerLimitError(eventName, this.maxListeners);
    }

    listenerSet.add(stored);

    return () => {
      this.off(eventName, listener);
    };
  }

  public once<TName extends RuntimeEventName>(
    eventName: TName,
    listener: RuntimeEventListener<TName>
  ): () => void {
    const wrapped = ((event: RuntimeEvent<TName>) => {
      this.off(eventName, wrapped);
      return listener(event);
    }) as RuntimeEventListener<TName> & { originalListener?: Listener };
    wrapped.originalListener = listener as Listener;

    this.on(eventName, wrapped);
    return () => this.off(eventName, wrapped);
  }

  public off<TName extends RuntimeEventName>(
    eventName: TName,
    listener: RuntimeEventListener<TName>
  ): boolean {
    const listenerSet = this.listeners.get(eventName);
    if (!listenerSet) {
      return false;
    }
    const target = listener as Listener;
    if (listenerSet.delete(target)) {
      return true;
    }
    for (const item of listenerSet) {
      if ((item as OnceListener).originalListener === target) {
        listenerSet.delete(item);
        return true;
      }
    }
    return false;
  }

  public listenerCount(eventName?: RuntimeEventName): number {
    if (eventName === undefined) {
      let total = 0;
      for (const listenerSet of this.listeners.values()) {
        total += listenerSet.size;
      }
      return total;
    }
    return this.listeners.get(eventName)?.size ?? 0;
  }

  public clear(): void {
    this.listeners.clear();
  }

  public emit<TName extends RuntimeEventName>(
    event: RuntimeEvent<TName>
  ): void {
    const listenerSet = this.listeners.get(event.name);
    if (!listenerSet) {
      return;
    }

    // Snapshot so listeners added during dispatch do not fire on this emit,
    // while still honoring removals that happen mid-dispatch.
    const snapshot = Array.from(listenerSet);

    for (const listener of snapshot) {
      if (!this.listeners.get(event.name)?.has(listener)) {
        continue;
      }

      try {
        const result = listener(event) as unknown;
        if (isPromiseLike(result)) {
          Promise.resolve(result).catch((error: unknown) => {
            this.handleListenerError(event.name, error);
          });
        }
      } catch (error) {
        this.handleListenerError(event.name, error);
      }
    }
  }

  private getOrCreateListenerSet(eventName: RuntimeEventName): Set<Listener> {
    let listenerSet = this.listeners.get(eventName);
    if (!listenerSet) {
      listenerSet = new Set<Listener>();
      this.listeners.set(eventName, listenerSet);
    }
    return listenerSet;
  }

  private handleListenerError(
    eventName: RuntimeEventName,
    error: unknown
  ): void {
    console.error(
      `[RuntimeEventBus] Listener error during "${eventName}" (listener error):`,
      error
    );
    this.notifyListenerErrorObserver(error);

    if (
      eventName !== "runtime.internal.error" &&
      !this.isEmittingInternalError
    ) {
      this.isEmittingInternalError = true;
      try {
        this.emit({
          name: "runtime.internal.error",
          payload: {
            eventName,
            errorMessage: listenerErrorMessage(error),
            occurredAt: new Date().toISOString()
          }
        });
      } finally {
        this.isEmittingInternalError = false;
      }
    }
  }

  private notifyListenerErrorObserver(error: unknown): void {
    if (!this.onListenerError) {
      return;
    }

    try {
      const result = this.onListenerError(error) as unknown;
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch((observerError: unknown) => {
          console.error(
            "[RuntimeEventBus] onListenerError handler failed:",
            observerError
          );
        });
      }
    } catch (observerError) {
      console.error(
        "[RuntimeEventBus] onListenerError handler failed:",
        observerError
      );
    }
  }
}
