import { describe, expect, it, vi } from "vitest";
import {
  ActionExecutor,
  AllOfToolPolicy,
  createPaymentPrepTool,
  PAYMENT_PREP_TOOL_NAME,
  RuntimeEventBus,
  StellarPaymentIntentPolicy,
  ToolAllowlistPolicy,
  ToolRegistry
} from "../../src/index.js";
import type { RuntimeContext } from "../../src/index.js";

const context = {
  runtimeId: "composed-policy-runtime",
  taskId: "composed-policy-task",
  agent: { agentId: "treasury-agent" },
  now: "2026-09-13T10:05:00.000Z"
} as unknown as RuntimeContext;

describe("AllOfToolPolicy", () => {
  it("requires every policy and keeps denied payment intents outside quota/invocation accounting", async () => {
    const registry = new ToolRegistry();
    registry.register(createPaymentPrepTool());
    registry.register({
      name: "account.read",
      description: "Read account metadata",
      execute: () => "read-ok"
    });

    const policy = new AllOfToolPolicy([
      new ToolAllowlistPolicy([PAYMENT_PREP_TOOL_NAME]),
      new StellarPaymentIntentPolicy({
        wallets: [{ walletId: "treasury", maxAmount: "5" }]
      })
    ]);
    const eventBus = new RuntimeEventBus();
    const invoked = vi.fn();
    const denied = vi.fn();
    eventBus.on("runtime.tool.invoked", invoked);
    eventBus.on("runtime.tool.denied", denied);
    const executor = new ActionExecutor(
      registry,
      1,
      eventBus,
      undefined,
      undefined,
      policy
    );

    await expect(
      executor.execute(
        PAYMENT_PREP_TOOL_NAME,
        { walletId: "treasury", amount: "5.0000001" },
        context
      )
    ).rejects.toMatchObject({
      code: "TOOL_POLICY_DENIED",
      details: {
        reason: "Payment amount exceeds the wallet policy limit."
      }
    });
    expect(executor.getToolCallCount(context.taskId)).toBe(0);
    expect(invoked).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledTimes(1);

    await expect(
      executor.execute(
        PAYMENT_PREP_TOOL_NAME,
        { walletId: "treasury", amount: "5" },
        context
      )
    ).resolves.toMatchObject({
      status: "prepared",
      walletId: "treasury",
      amount: "5",
      isSimulated: true
    });
    expect(executor.getToolCallCount(context.taskId)).toBe(1);
    expect(invoked).toHaveBeenCalledTimes(1);

    const readContext = { ...context, taskId: "read-task" };
    await expect(
      executor.execute("account.read", {}, readContext)
    ).rejects.toMatchObject({
      code: "TOOL_POLICY_DENIED",
      details: {
        reason: 'Tool "account.read" is not in the runtime allowlist.'
      }
    });
  });

  it("short-circuits on the first denial before later policies run", async () => {
    const laterPolicy = { evaluate: vi.fn(() => ({ allowed: true })) };
    const composed = new AllOfToolPolicy([
      {
        evaluate: () => ({
          allowed: false,
          reason: "Denied before the consuming policy."
        })
      },
      laterPolicy
    ]);

    await expect(
      composed.evaluate({ toolName: "write", payload: {}, context })
    ).resolves.toEqual({
      allowed: false,
      reason: "Denied before the consuming policy."
    });
    expect(laterPolicy.evaluate).not.toHaveBeenCalled();
  });

  it("snapshots the policy list and rejects an empty composition", async () => {
    const policies = [new ToolAllowlistPolicy(["read"])];
    const composed = new AllOfToolPolicy(policies);
    policies.length = 0;

    await expect(
      composed.evaluate({ toolName: "write", payload: {}, context })
    ).resolves.toMatchObject({ allowed: false });
    expect(() => new AllOfToolPolicy([])).toThrow(RangeError);
  });
});
