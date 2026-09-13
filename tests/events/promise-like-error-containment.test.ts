import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../src/events/runtime-events.js";

function startedEvent(runtimeId: string) {
  return {
    name: "runtime.started" as const,
    payload: { runtimeId, occurredAt: new Date().toISOString() }
  };
}

function rejectedThenable(message: string) {
  return {
    then(
      resolve: (value?: unknown) => void,
      reject: (reason: unknown) => void
    ) {
      void resolve;
      reject(new Error(message));
    }
  };
}

async function flushPromiseLikeRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RuntimeEventBus PromiseLike error containment", () => {
  it("routes rejected thenable listeners through the normal error path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = vi.fn();
    const bus = new RuntimeEventBus({ onListenerError: observer });
    const internalErrors: string[] = [];

    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", () => rejectedThenable("thenable listener boom"));

    bus.emit(startedEvent("rt-listener-thenable"));
    await flushPromiseLikeRejections();

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ message: "thenable listener boom" })
    );
    expect(internalErrors).toEqual(["thenable listener boom"]);

    errorSpy.mockRestore();
  });

  it("routes rejected cross-realm promises and preserves their message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = vi.fn();
    const bus = new RuntimeEventBus({ onListenerError: observer });
    const internalErrors: string[] = [];
    const foreignPromise = runInNewContext(
      "Promise.reject(new Error('foreign listener boom'))"
    ) as PromiseLike<never>;

    expect(foreignPromise).not.toBeInstanceOf(Promise);
    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", () => foreignPromise);

    bus.emit(startedEvent("rt-listener-foreign"));
    await flushPromiseLikeRejections();

    expect(observer).toHaveBeenCalledTimes(1);
    expect(internalErrors).toEqual(["foreign listener boom"]);

    errorSpy.mockRestore();
  });

  it("contains rejected thenables returned by onListenerError", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = vi.fn(() => rejectedThenable("thenable observer boom"));
    const bus = new RuntimeEventBus({ onListenerError: observer });
    const internalErrors: string[] = [];

    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", () => {
      throw new Error("listener boom");
    });

    expect(() => bus.emit(startedEvent("rt-observer-thenable"))).not.toThrow();
    await flushPromiseLikeRejections();

    expect(observer).toHaveBeenCalledTimes(1);
    expect(internalErrors).toEqual(["listener boom"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[RuntimeEventBus] onListenerError handler failed:",
      expect.objectContaining({ message: "thenable observer boom" })
    );

    errorSpy.mockRestore();
  });

  it("contains hostile proxy prototype and message probes", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new RuntimeEventBus();
    const internalErrors: string[] = [];
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap");
        },
        get(target, property, receiver) {
          if (
            property === "message" ||
            property === "toString" ||
            property === Symbol.toPrimitive
          ) {
            throw new Error("getter trap");
          }
          return Reflect.get(target, property, receiver);
        }
      }
    );

    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", () => {
      throw hostile;
    });

    expect(() => bus.emit(startedEvent("rt-hostile-proxy"))).not.toThrow();
    expect(internalErrors).toEqual(["Unknown listener failure."]);

    errorSpy.mockRestore();
  });

  it("contains hostile message access on a same-realm Error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new RuntimeEventBus();
    const internalErrors: string[] = [];
    const hostileError = new Error("initial message");

    Object.defineProperty(hostileError, "message", {
      get() {
        throw new Error("message trap");
      }
    });

    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", () => {
      throw hostileError;
    });

    expect(() => bus.emit(startedEvent("rt-hostile-error"))).not.toThrow();
    expect(internalErrors).toEqual(["Unknown listener failure."]);

    errorSpy.mockRestore();
  });
});
