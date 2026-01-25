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

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  version?: string;
}

export class AnthropicChatModel extends ChatModel {
  provider = "anthropic";
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private version: string;

  constructor(config: AnthropicConfig) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model || "claude-3-opus-20240229";
    this.baseUrl = config.baseUrl || "https://api.anthropic.com/v1";
    this.version = config.version || "2023-06-01";
  }

  private async fetch(path: string, options: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.version,
        "content-type": "application/json",
        ...options.headers,
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API Error ${response.status}: ${error}`);
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
    // Anthropic requires system prompt to be top-level, separate from messages
    let system: string | undefined;
    const messages = request.messages.filter(m => {
      if (m.role === "system") {
        system = m.content;
        return false;
      }
      return true;
    });

    // Format tools if present
    let tools: any[] | undefined;
    if (request.tools && request.tools.length > 0) {
      tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }

    const body: any = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === "tool" ? "user" : m.role, // Mapping might need adjustment based on specific Anthropic tool use syntax
        content: m.content
      })),
      max_tokens: 4096,
      system,
      tools
    };

    if (request.tool_choice) {
       // Simplified mapping
       if (typeof request.tool_choice === 'string' && request.tool_choice !== 'auto') {
           body.tool_choice = { type: 'tool', name: request.tool_choice };
       } else if (typeof request.tool_choice === 'object') {
           body.tool_choice = request.tool_choice;
       } else if (request.tool_choice === 'auto') {
           body.tool_choice = { type: 'auto' };
       }
    }


    const response = await this.fetch("/messages", {
      method: "POST",
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    // Extract content
    let content = "";
    const tool_calls: any[] = [];
    
    for (const block of data.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: block.input
        });
      }
    }

    const usage: TokenUsage | undefined = data.usage ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens
    } : undefined;

    return {
      message: {
        role: "assistant",
        content,
      },
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      usage,
      raw: data
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.fetch("/messages", {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: 4096,
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
        if (!line.startsWith("data: ")) continue;
        
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const event = JSON.parse(dataStr);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
             const delta = event.delta.text;
             yield {
                type: "content",
                content: delta,
                delta: delta
             };
          } else if (event.type === "message_stop") {
             yield { type: "end", finish_reason: "stop" };
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }
    
    // Ensure end event is sent if not encountered in stream
    yield { type: "end", finish_reason: "stop" };
  }
}
