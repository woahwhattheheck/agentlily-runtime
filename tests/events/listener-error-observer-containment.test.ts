import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../../src/events/runtime-events.js";

function startedEvent(runtimeId: string) {
  return {
    name: "runtime.started" as const,
    payload: { runtimeId, occurredAt: new Date().toISOString() }
  };
}

describe("RuntimeEventBus listener error observer containment", () => {
  it("does not let a synchronous onListenerError failure escape emit", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = vi.fn(() => {
      throw new Error("observer boom");
    });
    const bus = new RuntimeEventBus({ onListenerError: observer });
    const internalErrors: string[] = [];

    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", () => {
      throw new Error("listener boom");
    });

    expect(() => bus.emit(startedEvent("rt-sync"))).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(internalErrors).toEqual(["listener boom"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[RuntimeEventBus] onListenerError handler failed:",
      expect.objectContaining({ message: "observer boom" })
    );

    errorSpy.mockRestore();
  });

  it("handles a rejected async onListenerError without losing the internal error event", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const observer = vi.fn(async () => {
      throw new Error("observer async boom");
    });
    const bus = new RuntimeEventBus({ onListenerError: observer });
    const internalErrors: string[] = [];

    bus.on("runtime.internal.error", (event) => {
      internalErrors.push(event.payload.errorMessage);
    });
    bus.on("runtime.started", async () => {
      throw new Error("listener async boom");
    });

    bus.emit(startedEvent("rt-async"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observer).toHaveBeenCalledTimes(1);
    expect(internalErrors).toEqual(["listener async boom"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[RuntimeEventBus] onListenerError handler failed:",
      expect.objectContaining({ message: "observer async boom" })
    );

    errorSpy.mockRestore();
  });
});
