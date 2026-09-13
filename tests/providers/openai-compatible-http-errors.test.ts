import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../../src/providers/openai-compatible-provider.js";

const prompt = { instructions: "system", input: "user" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleModelProvider HTTP errors", () => {
  it.each([400, 401, 403, 429, 500, 503])(
    "returns only HTTP status for non-2xx response %s",
    async (status) => {
      const sentinel = `provider-secret-sentinel-${status}`;
      const text = vi.fn(async () => `${sentinel}${"x".repeat(100_000)}`);
      const response = {
        ok: false,
        status,
        text
      } as unknown as Response;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      const provider = new OpenAICompatibleModelProvider({
        apiKey: "test-key"
      });

      let rejection: unknown;
      try {
        await provider.generate(prompt);
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        `OpenAI-compatible provider returned HTTP ${status}.`
      );
      expect((rejection as Error).message).not.toContain(sentinel);
      expect(text).not.toHaveBeenCalled();
    }
  );

  it("does not materialize a non-2xx body even when reading it would throw", async () => {
    const text = vi.fn(async () => {
      throw new Error("body reader should not run");
    });
    const response = {
      ok: false,
      status: 502,
      text
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const provider = new OpenAICompatibleModelProvider({ apiKey: "test-key" });

    await expect(provider.generate(prompt)).rejects.toThrow(
      "OpenAI-compatible provider returned HTTP 502."
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("continues to read and parse successful response bodies", async () => {
    const text = vi.fn(async () =>
      JSON.stringify({
        model: "test-model",
        choices: [
          {
            message: { content: "ok" },
            finish_reason: "stop"
          }
        ]
      })
    );
    const response = {
      ok: true,
      status: 200,
      text
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const provider = new OpenAICompatibleModelProvider({ apiKey: "test-key" });

    await expect(provider.generate(prompt)).resolves.toEqual({
      outputText: "ok",
      metadata: {
        model: "test-model",
        finishReason: "stop"
      }
    });
    expect(text).toHaveBeenCalledTimes(1);
  });
});
