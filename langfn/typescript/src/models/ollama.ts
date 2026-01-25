import { ChatModel } from "./base.js";
import { 
  ChatRequest, 
  ChatResponse, 
  CompletionRequest, 
  CompletionResponse, 
  StreamEvent,
  TokenUsage
} from "../core/types.js";

export interface OllamaConfig {
  model?: string;
  baseUrl?: string;
}

export class OllamaChatModel extends ChatModel {
  provider = "ollama";
  model: string;
  private baseUrl: string;

  constructor(config: OllamaConfig = {}) {
    super();
    this.model = config.model || "llama3";
    this.baseUrl = config.baseUrl || "http://localhost:11434";
  }

  private async fetch(path: string, options: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API Error ${response.status}: ${error}`);
    }

    return response;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const chatResp = await this.chat({
      messages: [{ role: "user", content: request.prompt }],
      metadata: request.metadata
    });

    return {
      content: chatResp.message.content,
      usage: chatResp.usage,
      raw: chatResp.raw,
      trace_id: chatResp.trace_id
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        stream: false
      })
    });

    const data = await response.json();
    const message = data.message;

    const usage: TokenUsage | undefined = data.eval_count ? {
      prompt_tokens: data.prompt_eval_count || 0,
      completion_tokens: data.eval_count || 0,
      total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
    } : undefined;

    return {
      message: {
        role: message.role,
        content: message.content || "",
      },
      usage,
      raw: data
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: request.prompt }],
        stream: true
      })
    });

    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.done) {
            yield { type: "end", finish_reason: "stop" };
            return;
          }
          const delta = chunk.message?.content;
          if (delta) {
            yield {
              type: "content",
              content: delta,
              delta: delta
            };
          }
        } catch (e) {
          // ignore
        }
      }
    }

    yield { type: "end", finish_reason: "stop" };
  }
}
