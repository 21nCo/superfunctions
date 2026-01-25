import { ChatModel } from "./base.js";
import { 
  ChatRequest, 
  ChatResponse, 
  CompletionRequest, 
  CompletionResponse, 
  StreamEvent,
  Message,
  TokenUsage
} from "../core/types.js";

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
}

export class OpenAIChatModel extends ChatModel {
  provider = "openai";
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private organization?: string;
  private project?: string;

  constructor(config: OpenAIConfig) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-4-turbo-preview";
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.organization = config.organization;
    this.project = config.project;
  }

  private async fetch(path: string, options: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
      ...(this.organization ? { "OpenAI-Organization": this.organization } : {}),
      ...(this.project ? { "OpenAI-Project": this.project } : {})
    };

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API Error ${response.status}: ${error}`);
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
    const body: any = {
      model: this.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice
    };

    const response = await this.fetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body)
    });

    const data = await response.json();
    const choice = data.choices[0];
    const message = choice.message;
    
    // Parse tool calls if present
    const tool_calls = message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments)
    }));

    const usage: TokenUsage | undefined = data.usage ? {
      prompt_tokens: data.usage.prompt_tokens,
      completion_tokens: data.usage.completion_tokens,
      total_tokens: data.usage.total_tokens
    } : undefined;

    return {
      message: {
        role: message.role,
        content: message.content || "",
      },
      tool_calls,
      usage,
      raw: data
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.fetch("/chat/completions", {
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
        if (line.trim() === "" || line.trim() === "data: [DONE]") continue;
        if (!line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices[0]?.delta?.content;
          if (delta) {
            yield {
              type: "content",
              content: delta,
              delta: delta
            };
          }
        } catch (e) {
          console.warn("Failed to parse stream chunk", e);
        }
      }
    }

    yield { type: "end", finish_reason: "stop" };
  }
}
