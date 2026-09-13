import { describe, expect, it, vi } from "vitest";
import {
  RuntimeEventBus,
  RuntimeEventListenerLimitError
} from "../../src/events/runtime-events.js";

describe("RuntimeEventBus max listeners", () => {
  it("rejects registrations that exceed a numeric maxListeners value", () => {
    const bus = new RuntimeEventBus(2);

    bus.on("runtime.started", () => {});
    bus.on("runtime.started", () => {});

    expect(() => bus.on("runtime.started", () => {})).toThrow(
      RuntimeEventListenerLimitError
    );
    expect(bus.listenerCount("runtime.started")).toBe(2);
  });

  it("exposes listenerCount", () => {
    const bus = new RuntimeEventBus();
    expect(bus.listenerCount("runtime.started")).toBe(0);

    const unsub = bus.on("runtime.started", () => {});
    expect(bus.listenerCount("runtime.started")).toBe(1);

    unsub();
    expect(bus.listenerCount("runtime.started")).toBe(0);
  });

  it("defaults to 100 max listeners", () => {
    const bus = new RuntimeEventBus();

    for (let i = 0; i < 100; i++) {
      bus.on("runtime.started", () => {});
    }

    expect(() => bus.on("runtime.started", () => {})).toThrow(
      RuntimeEventListenerLimitError
    );
    expect(bus.listenerCount("runtime.started")).toBe(100);
  });
});

describe("RuntimeEventBus once() async rejection", () => {
  it("catches rejections from async once listeners via onListenerError", async () => {
    const errorSpy = vi.fn();
    const bus = new RuntimeEventBus({ onListenerError: errorSpy });

    bus.once("runtime.started", async () => {
      throw new Error("async once failure");
    });

    bus.emit({
      name: "runtime.started",
      payload: { runtimeId: "r1", occurredAt: "2026-01-01T00:00:00Z" }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((errorSpy.mock.calls[0]![0] as Error).message).toBe(
      "async once failure"
    );
  });

  it("removes once listener before an async callback settles", async () => {
    const bus = new RuntimeEventBus();
    let callCount = 0;

    bus.once("runtime.started", async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    bus.emit({
      name: "runtime.started",
      payload: { runtimeId: "r1", occurredAt: "2026-01-01T00:00:00Z" }
    });
    bus.emit({
      name: "runtime.started",
      payload: { runtimeId: "r1", occurredAt: "2026-01-01T00:00:00Z" }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callCount).toBe(1);
  });
});
