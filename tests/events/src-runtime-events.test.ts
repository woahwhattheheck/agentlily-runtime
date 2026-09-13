import { describe, expect, it } from "vitest";
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
