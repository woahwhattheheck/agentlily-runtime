import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  AgentInstanceManager,
  createPaymentPrepTool,
  InMemoryMemoryStore,
  InMemoryRuntimeStateStore,
  PAYMENT_PREP_TOOL_NAME,
  RuntimeError,
  UnconfiguredModelProvider
} from "../src/index.js";
import type { PaymentPrepPayload, RuntimeContext } from "../src/index.js";

describe("PaymentPrepAction", () => {
  const createMockContext = (taskId: string): RuntimeContext => ({
    runtimeId: "runtime-test",
    taskId,
    agent: new AgentInstanceManager().getOrCreate("test-agent"),
    memory: new InMemoryMemoryStore(),
    modelProvider: new UnconfiguredModelProvider(),
    state: new InMemoryRuntimeStateStore(),
    now: "2026-08-30T12:00:00.000Z"
  });

  it("creates a tool with correct name and description metadata", () => {
    const tool = createPaymentPrepTool();
    expect(tool.name).toBe(PAYMENT_PREP_TOOL_NAME);
    expect(tool.description).toContain(
      "without performing live Stellar network calls"
    );
  });

  it("prepares valid payment context and transaction stub", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-1");

    const payload: PaymentPrepPayload = {
      walletId: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      amount: "150.50",
      recipientId: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      assetCode: "USDC",
      assetIssuer: "GISSUERUSDC1",
      memo: "Invoice #1024",
      metadata: { priority: "high" }
    };

    const result = await tool.execute({ payload, context });

    expect(result).toEqual({
      status: "prepared",
      walletId: payload.walletId,
      amount: "150.50",
      recipientId: payload.recipientId,
      assetCode: "USDC",
      assetIssuer: "GISSUERUSDC1",
      memo: "Invoice #1024",
      preparedAt: "2026-08-30T12:00:00.000Z",
      transactionStubId: expect.stringMatching(
        new RegExp(`^stellar-stub-task-pay-1-${payload.walletId}-[0-9a-f]{64}$`)
      ),
      isSimulated: true,
      metadata: { priority: "high" }
    });
  });

  it("binds stub identity to the canonical payment intent", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-intent-id");
    const base: PaymentPrepPayload = {
      walletId: "GWALLET123",
      amount: "1.0",
      recipientId: "GRECIPIENT1",
      assetCode: "USDC",
      assetIssuer: "GISSUER1",
      memo: "invoice-1",
      metadata: { source: "first" }
    };

    const original = await tool.execute({ payload: base, context });
    const equivalent = await tool.execute({
      payload: { ...base, amount: 1, metadata: { source: "second" } },
      context
    });

    expect(equivalent.transactionStubId).toBe(original.transactionStubId);

    const changedIntents: PaymentPrepPayload[] = [
      { ...base, amount: "2.0" },
      { ...base, recipientId: "GRECIPIENT2" },
      { ...base, assetCode: "EURC" },
      { ...base, assetIssuer: "GISSUER2" },
      { ...base, memo: "invoice-2" }
    ];

    for (const payload of changedIntents) {
      const changed = await tool.execute({ payload, context });
      expect(changed.transactionStubId).not.toBe(original.transactionStubId);
    }
  });

  it("requires issuer identity for non-native assets", () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-issued-needs-issuer");

    expect(() =>
      tool.execute({
        payload: {
          walletId: "GWALLET123",
          amount: "10",
          assetCode: "USDC"
        },
        context
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_TASK",
        details: { fieldName: "assetIssuer", assetCode: "USDC" }
      })
    );
  });

  it("treats equal asset codes from different issuers as different intents", () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-issued-identity");
    const base: PaymentPrepPayload = {
      walletId: "GWALLET123",
      amount: "25",
      recipientId: "GRECIPIENT1",
      assetCode: "USDC",
      assetIssuer: "GISSUER1"
    };

    const first = tool.execute({ payload: base, context });
    const second = tool.execute({
      payload: { ...base, assetIssuer: "GISSUER2" },
      context
    });

    expect(first.transactionStubId).not.toBe(second.transactionStubId);
    expect(first.assetIssuer).toBe("GISSUER1");
    expect(second.assetIssuer).toBe("GISSUER2");
  });

  it("preserves native XLM stub identity from the pre-issuer format", () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-native-compat");
    const walletId = "GWALLET123";
    const result = tool.execute({
      payload: { walletId, amount: "25" },
      context
    });
    const priorCanonicalIntent = JSON.stringify([
      context.taskId,
      walletId,
      null,
      "XLM",
      "250000000",
      null
    ]);
    const priorDigest = createHash("sha256")
      .update(priorCanonicalIntent, "utf8")
      .digest("hex");

    expect(result.transactionStubId).toBe(
      `stellar-stub-${context.taskId}-${walletId}-${priorDigest}`
    );
    expect(result.assetIssuer).toBeUndefined();
  });

  it("handles numeric amount and defaults assetCode to XLM", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-2");

    const result = await tool.execute({
      payload: {
        walletId: "GWALLET123",
        amount: 25
      },
      context
    });

    expect(result.amount).toBe("25");
    expect(result.assetCode).toBe("XLM");
    expect(result.assetIssuer).toBeUndefined();
    expect(result.status).toBe("prepared");
    expect(result.isSimulated).toBe(true);
  });

  it("normalizes the smallest numeric Stellar unit out of exponent notation", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-smallest-unit");

    const result = await tool.execute({
      payload: {
        walletId: "GWALLET123",
        amount: 1e-7
      },
      context
    });

    expect(result.amount).toBe("0.0000001");
  });

  it("rejects empty walletId", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-3");

    expect(() =>
      tool.execute({
        payload: {
          walletId: "",
          amount: "10"
        },
        context
      })
    ).toThrowError(RuntimeError);
  });

  it("rejects invalid asset codes before preparing an intent", () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-invalid-asset-code");

    for (const assetCode of ["US D", "USD_", "1234567890123"]) {
      expect(() =>
        tool.execute({
          payload: {
            walletId: "GWALLET123",
            amount: "10",
            assetCode,
            assetIssuer: "GISSUER1"
          },
          context
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { fieldName: "assetCode", assetCode }
        })
      );
    }
  });

  it("rejects malformed runtime issuer values without coercion", () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-invalid-issuer");

    for (const assetIssuer of [123, true, {}, " GISSUER1", "GISSUER1 "]) {
      expect(() =>
        tool.execute({
          payload: {
            walletId: "GWALLET123",
            amount: "10",
            assetCode: "USDC",
            assetIssuer: assetIssuer as unknown as string
          },
          context
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { fieldName: "assetIssuer" }
        })
      );
    }
  });

  it("rejects missing or empty amount", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-4");

    expect(() =>
      tool.execute({
        payload: {
          walletId: "GWALLET123",
          amount: ""
        },
        context
      })
    ).toThrowError(RuntimeError);
  });

  it("rejects non-string/non-number runtime amount types without coercion", () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-runtime-types");
    let toStringCalled = false;
    const coercibleObject = {
      toString() {
        toStringCalled = true;
        return "10";
      }
    };

    for (const amount of [true, [1], coercibleObject]) {
      expect(() =>
        tool.execute({
          payload: {
            walletId: "GWALLET123",
            amount: amount as unknown as PaymentPrepPayload["amount"]
          },
          context
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { fieldName: "amount" }
        })
      );
    }

    expect(toStringCalled).toBe(false);
  });

  it("rejects negative or invalid numeric amount", async () => {
    const tool = createPaymentPrepTool();
    const context = createMockContext("task-pay-5");

    expect(() =>
      tool.execute({
        payload: {
          walletId: "GWALLET123",
          amount: -50
        },
        context
      })
    ).toThrowError(RuntimeError);

    expect(() =>
      tool.execute({
        payload: {
          walletId: "GWALLET123",
          amount: "invalid-amount"
        },
        context
      })
    ).toThrowError(RuntimeError);
  });

  it.each(["Infinity", "NaN", "1e309"])(
    "rejects non-finite amount %s with INVALID_TASK",
    (amount) => {
      const tool = createPaymentPrepTool();
      const context = createMockContext(`task-nonfinite-${amount}`);

      expect(() =>
        tool.execute({
          payload: {
            walletId: "GWALLET123",
            amount
          },
          context
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { amount }
        })
      );
    }
  );

  it.each(["0x10", "0b10", "0o10", "1e2", "1.00000001", " 10 "])(
    "rejects non-Stellar decimal syntax %s",
    (amount) => {
      const tool = createPaymentPrepTool();
      const context = createMockContext(`task-invalid-decimal-${amount}`);

      expect(() =>
        tool.execute({
          payload: {
            walletId: "GWALLET123",
            amount
          },
          context
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { amount }
        })
      );
    }
  );

  it.each(["922337203685.4775808", "999999999999999999999999999"])(
    "rejects Stellar amount overflow %s",
    (amount) => {
      const tool = createPaymentPrepTool();
      const context = createMockContext(`task-overflow-${amount}`);

      expect(() =>
        tool.execute({
          payload: {
            walletId: "GWALLET123",
            amount
          },
          context
        })
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_TASK",
          details: { amount }
        })
      );
    }
  );

  it.each(["10.5", 10, "0.01", "0.0000001", "922337203685.4775807"])(
    "accepts finite positive Stellar amount %s",
    async (amount) => {
      const tool = createPaymentPrepTool();
      const context = createMockContext(`task-finite-${amount}`);

      const result = await tool.execute({
        payload: {
          walletId: "GWALLET123",
          amount
        },
        context
      });

      expect(result.status).toBe("prepared");
    }
  );
});
