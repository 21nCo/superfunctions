import {
  ChatRequest,
  ChatResponse,
  CompletionRequest,
  CompletionResponse,
  StreamEvent
} from "../core/types.js";
import { ProviderAuthError, ProviderError, RateLimitError } from "../core/errors.js";
import { ChatModel } from "./base.js";
import { getTransportClient } from "./transport.js";

export interface GoogleConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeout?: number;
  fetchImpl?: typeof fetch;
}

export class GoogleChatModel extends ChatModel {
  readonly provider = "google";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(config: GoogleConfig = {}) {
    super();
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "gemini-1.5-flash";
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.timeout = config.timeout ?? 60_000;
    this.fetchImpl = config.fetchImpl;
  }

  private get client() {
    return getTransportClient({
      baseUrl: this.baseUrl,
      headers: { "content-type": "application/json" },
      timeout: this.timeout,
      fetchImpl: this.fetchImpl
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const chat = await this.chat({
      messages: [{ role: "user", content: request.prompt }],
      metadata: request.metadata
    });
    return { content: chat.message.content, usage: chat.usage, raw: chat.raw };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const payload = {
      contents: request.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role,
          parts: [{ text: message.content }]
        }))
    };

    const response = await this.client.request(`/models/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await raiseForStatus(this.provider, response);
    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((part: Record<string, any>) => String(part.text ?? "")).join("");
    return {
      message: { role: "assistant", content },
      raw: data
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const completion = await this.complete(request);
    yield { type: "content", content: completion.content, delta: completion.content };
    yield { type: "end", finish_reason: "stop" };
  }
}

async function raiseForStatus(provider: string, response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 401) {
    throw new ProviderAuthError(undefined, { provider, metadata: { status: response.status, body } });
  }
  if (response.status === 429) {
    throw new RateLimitError(undefined, { provider, metadata: { status: response.status, body } });
  }
  throw new ProviderError(`Google request failed (${response.status})`, {
    provider,
    metadata: { status: response.status, body }
  });
}
