import { describe, expect, it } from "vitest";
import { AgentInstanceManager } from "../../src/agents/agent-instance-manager.js";

describe("AgentInstanceManager maxInstances validation", () => {
  it.each([
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])("rejects invalid maxInstances %s", (maxInstances) => {
    expect(() => new AgentInstanceManager({ maxInstances })).toThrow(
      new RangeError("maxInstances must be a non-negative integer.")
    );
  });

  it("preserves maxInstances 0 as explicitly unbounded", () => {
    const manager = new AgentInstanceManager({ maxInstances: 0 });

    for (let index = 0; index < 3; index++) {
      manager.getOrCreate(`agent-${index}`);
    }

    expect(manager.list().map((agent) => agent.agentId)).toEqual([
      "agent-0",
      "agent-1",
      "agent-2"
    ]);
    expect(manager.getEvictionCount()).toBe(0);
  });

  it("continues to accept positive integer capacities", () => {
    const manager = new AgentInstanceManager({ maxInstances: 1 });

    manager.getOrCreate("first");
    manager.getOrCreate("second");

    expect(manager.list().map((agent) => agent.agentId)).toEqual(["second"]);
    expect(manager.getEvictionCount()).toBe(1);
  });
});
