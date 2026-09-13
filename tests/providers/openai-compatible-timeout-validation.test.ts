import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../../src/providers/openai-compatible-provider.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

describe("OpenAICompatibleModelProvider timeoutMs validation", () => {
  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    MAX_TIMER_DELAY_MS + 1
  ])("rejects invalid timeoutMs %s before any request", (timeoutMs) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(
      () =>
        new OpenAICompatibleModelProvider({
          apiKey: "test-key",
          timeoutMs
        })
    ).toThrow(
      `OpenAI-compatible provider timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("rejects non-number timeoutMs values passed at runtime", () => {
    expect(
      () =>
        new OpenAICompatibleModelProvider({
          apiKey: "test-key",
          timeoutMs: "1000" as unknown as number
        })
    ).toThrow(
      `OpenAI-compatible provider timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`
    );
  });

  it.each([0, 1, MAX_TIMER_DELAY_MS])(
    "accepts supported timeoutMs %s",
    (timeoutMs) => {
      expect(
        () =>
          new OpenAICompatibleModelProvider({
            apiKey: "test-key",
            timeoutMs
          })
      ).not.toThrow();
    }
  );

  it("still allows timeoutMs to be omitted", () => {
    expect(
      () => new OpenAICompatibleModelProvider({ apiKey: "test-key" })
    ).not.toThrow();
  });
});
