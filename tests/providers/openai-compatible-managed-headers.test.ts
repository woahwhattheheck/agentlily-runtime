import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../../src/providers/openai-compatible-provider.js";

describe("OpenAICompatibleModelProvider managed headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps auth and content type provider-managed while preserving custom headers", async () => {
    const customHeaders: Record<string, string> = {
      authorization: "Bearer caller-controlled",
      "CONTENT-TYPE": "text/plain",
      "X-Trace-Id": "trace-original"
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }]
        }),
        { status: 200 }
      )
    );
    const provider = new OpenAICompatibleModelProvider({
      apiKey: "trusted-key",
      headers: customHeaders
    });

    customHeaders["X-Trace-Id"] = "trace-mutated-after-construction";

    await expect(
      provider.generate({ instructions: "system", input: "user" })
    ).resolves.toMatchObject({ outputText: "ok" });

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toEqual({
      "X-Trace-Id": "trace-original",
      "Content-Type": "application/json",
      Authorization: "Bearer trusted-key"
    });
  });
});
