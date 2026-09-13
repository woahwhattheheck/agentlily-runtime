import { describe, expect, it } from "vitest";
import { OpenAICompatibleModelProvider } from "../src/index.js";

describe("OpenAICompatibleModelProvider base URL boundary", () => {
  it.each([
    "https://provider.example/v1?tenant=alpha",
    "https://provider.example/v1?"
  ])("rejects query-bearing base URLs: %s", (baseUrl) => {
    expect(
      () => new OpenAICompatibleModelProvider({ apiKey: "test-key", baseUrl })
    ).toThrowError(
      "OpenAI-compatible provider baseUrl must not include a query string or fragment."
    );
  });

  it.each([
    "https://provider.example/v1#models",
    "https://provider.example/v1#"
  ])("rejects fragment-bearing base URLs: %s", (baseUrl) => {
    expect(
      () => new OpenAICompatibleModelProvider({ apiKey: "test-key", baseUrl })
    ).toThrowError(
      "OpenAI-compatible provider baseUrl must not include a query string or fragment."
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
