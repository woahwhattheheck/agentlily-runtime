import type {
  ModelPrompt,
  ModelProvider,
  ModelResponse
} from "./model-provider.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MANAGED_REQUEST_HEADERS = new Set(["authorization", "content-type"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyCustomHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!MANAGED_REQUEST_HEADERS.has(name.toLowerCase())) {
      safeHeaders[name] = value;
    }
  }
  return safeHeaders;
}

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  public readonly name = "openai-compatible";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number | undefined;
  private readonly customHeaders: Record<string, string> | undefined;

  public constructor(options: OpenAICompatibleProviderOptions) {
    if (
      !options.apiKey ||
      typeof options.apiKey !== "string" ||
      options.apiKey.trim().length === 0
    ) {
      throw new Error(
        "OpenAI-compatible provider requires a non-empty apiKey."
      );
    }

    const rawBaseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim().length === 0) {
      throw new Error("OpenAI-compatible provider requires a valid baseUrl.");
    }

    try {
      new URL(rawBaseUrl);
    } catch {
      throw new Error(
        `Invalid baseUrl provided to OpenAICompatibleModelProvider: "${rawBaseUrl}".`
      );
    }

    if (
      options.timeoutMs !== undefined &&
      (typeof options.timeoutMs !== "number" ||
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 0 ||
        options.timeoutMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new Error(
        `OpenAI-compatible provider timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`
      );
    }

    this.apiKey = options.apiKey.trim();
    this.baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
    this.model = options.model?.trim() || "gpt-4o-mini";
    this.timeoutMs = options.timeoutMs;
    this.customHeaders = copyCustomHeaders(options.headers);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getModel(): string {
    return this.model;
  }

  public async generate(prompt: ModelPrompt): Promise<ModelResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: prompt.instructions },
        { role: "user", content: prompt.input }
      ]
    };

    let response: Response;
    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        ...(this.customHeaders ?? {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    };

    if (this.timeoutMs !== undefined) {
      requestInit.signal = AbortSignal.timeout(this.timeoutMs);
    }

    try {
      response = await fetch(url, requestInit);
    } catch {
      // Fetch implementations, proxies, or adapters may include credentials in
      // thrown diagnostics. Keep the public provider boundary categorical only.
      throw new Error("OpenAI-compatible provider request failed.");
    }

    // Error bodies are remote-controlled and may be arbitrarily large or
    // contain reflected credentials. The HTTP status is sufficient for the
    // public provider error, so do not materialize or serialize the body.
    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible provider returned HTTP ${response.status}.`
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      // Body readers can surface transport- or adapter-specific diagnostics.
      // Expose the safe HTTP status, not the upstream exception object.
      throw new Error(
        `OpenAI-compatible provider could not read HTTP ${response.status} response body.`
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(responseText) as unknown;
    } catch {
      // Even a successful endpoint can reflect sensitive content in malformed
      // bodies. Do not quote body bytes or attach the parser exception.
      throw new Error(
        `OpenAI-compatible provider returned invalid JSON (HTTP ${response.status}).`
      );
    }

    if (
      !isRecord(data) ||
      !Array.isArray(data.choices) ||
      data.choices.length === 0
    ) {
      throw new Error(
        `OpenAI-compatible provider returned malformed response (HTTP ${response.status}): expected a non-empty choices array.`
      );
    }

    const choice: unknown = data.choices[0];
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      typeof choice.message.content !== "string"
    ) {
      throw new Error(
        `OpenAI-compatible provider returned malformed response (HTTP ${response.status}): expected choices[0].message.content to be a string.`
      );
    }

    // Explicit empty strings are valid text responses. Missing/null content,
    // including tool-call-only completions, cannot satisfy this text-only API.
    const outputText = choice.message.content;
    const metadata: Record<string, unknown> = {
      model: data.model ?? this.model
    };

    if (choice.finish_reason !== undefined) {
      metadata.finishReason = choice.finish_reason;
    }
    if (data.usage !== undefined) {
      metadata.usage = data.usage;
    }

    return {
      outputText,
      metadata
    };
  }
}
