import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../../src/providers/openai-compatible-provider.js";

const prompt = { instructions: "system", input: "user" };
const sentinel = "sk-live-upstream-secret-SENTINEL";

afterEach(() => {
  vi.restoreAllMocks();
});

function expectSanitizedError(
  rejection: unknown,
  expectedMessage: string
): void {
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe(expectedMessage);
  expect((rejection as Error).message).not.toContain(sentinel);
  expect("cause" in (rejection as Error & { cause?: unknown })).toBe(false);
}

describe("OpenAICompatibleModelProvider diagnostic sanitization", () => {
  it("does not expose fetch exception diagnostics", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(`proxy failed with credential ${sentinel}`)
    );
    const provider = new OpenAICompatibleModelProvider({ apiKey: "test-key" });

    let rejection: unknown;
    try {
      await provider.generate(prompt);
    } catch (error) {
      rejection = error;
    }

    expectSanitizedError(
      rejection,
      "OpenAI-compatible provider request failed."
    );
  });

  it("does not expose successful-response body-reader exceptions", async () => {
    const response = {
      ok: true,
      status: 200,
      text: vi.fn(async () => {
        throw new Error(`stream failed with credential ${sentinel}`);
      })
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const provider = new OpenAICompatibleModelProvider({ apiKey: "test-key" });

    let rejection: unknown;
    try {
      await provider.generate(prompt);
    } catch (error) {
      rejection = error;
    }

    expectSanitizedError(
      rejection,
      "OpenAI-compatible provider could not read HTTP 200 response body."
    );
  });

  it("does not quote malformed successful response bodies", async () => {
    const response = {
      ok: true,
      status: 200,
      text: vi.fn(async () => `not-json ${sentinel}`)
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const provider = new OpenAICompatibleModelProvider({ apiKey: "test-key" });

    let rejection: unknown;
    try {
      await provider.generate(prompt);
    } catch (error) {
      rejection = error;
    }

    expectSanitizedError(
      rejection,
      "OpenAI-compatible provider returned invalid JSON (HTTP 200)."
    );
  });
});
