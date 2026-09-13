import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../src/index.js";

describe("OpenAICompatibleModelProvider base URL boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "https://provider.example/v1?tenant=alpha",
      "https://provider.example/v1/chat/completions?tenant=alpha"
    ],
    [
      "https://provider.example/v1/?tenant=alpha",
      "https://provider.example/v1/chat/completions?tenant=alpha"
    ],
    [
      "https://provider.example/v1?",
      "https://provider.example/v1/chat/completions?"
    ]
  ])("preserves base URL query routing: %s", async (baseUrl, expectedUrl) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 }
      )
    );
    const provider = new OpenAICompatibleModelProvider({
      apiKey: "test-key",
      baseUrl
    });

    await provider.generate({ instructions: "test", input: "test" });

    expect(fetchSpy).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
  });

  it.each([
    "https://provider.example/v1#models",
    "https://provider.example/v1#"
  ])("rejects fragment-bearing base URLs: %s", (baseUrl) => {
    expect(
      () => new OpenAICompatibleModelProvider({ apiKey: "test-key", baseUrl })
    ).toThrowError(
      "OpenAI-compatible provider baseUrl must not include a fragment."
    );
  });

  it.each(["file:///tmp/openai", "ftp://provider.example/v1"])(
    "rejects non-HTTP base URL schemes: %s",
    (baseUrl) => {
      expect(
        () => new OpenAICompatibleModelProvider({ apiKey: "test-key", baseUrl })
      ).toThrowError(
        "OpenAI-compatible provider baseUrl must use http or https."
      );
    }
  );

  it("keeps percent-encoded path delimiters as path data", () => {
    const provider = new OpenAICompatibleModelProvider({
      apiKey: "test-key",
      baseUrl: "https://provider.example/v1%3Ftenant%3Dalpha%23models/"
    });

    expect(provider.getBaseUrl()).toBe(
      "https://provider.example/v1%3Ftenant%3Dalpha%23models"
    );
  });
});
