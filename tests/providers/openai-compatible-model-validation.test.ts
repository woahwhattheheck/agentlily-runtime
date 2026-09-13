import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../../src/providers/openai-compatible-provider.js";

const MODEL_ERROR =
  "OpenAI-compatible provider model must be a non-empty string.";

describe("OpenAICompatibleModelProvider model validation", () => {
  it("uses the documented default when model is omitted", () => {
    const provider = new OpenAICompatibleModelProvider({ apiKey: "test-key" });

    expect(provider.getModel()).toBe("gpt-4o-mini");
  });

  it("trims and preserves an explicitly configured model", () => {
    const provider = new OpenAICompatibleModelProvider({
      apiKey: "test-key",
      model: "  custom-model-v1  "
    });

    expect(provider.getModel()).toBe("custom-model-v1");
  });

  it.each(["", "   ", "\n\t"])(
    "rejects blank model %j before any request",
    (model) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      expect(
        () =>
          new OpenAICompatibleModelProvider({
            apiKey: "test-key",
            model
          })
      ).toThrow(MODEL_ERROR);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    }
  );

  it("rejects non-string model values passed at runtime", () => {
    expect(
      () =>
        new OpenAICompatibleModelProvider({
          apiKey: "test-key",
          model: 7 as unknown as string
        })
    ).toThrow(MODEL_ERROR);
  });
});
