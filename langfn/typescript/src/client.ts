import { ChatModel } from "./models/base.js";
import { 
  ChatRequest, 
  ChatResponse, 
  CompletionRequest, 
  CompletionResponse, 
  StreamEvent,
  Message
} from "./core/types.js";
import { Tool } from "./tools/base.js";

import { StructuredOutput } from "./structured/output.js";
import { z } from "zod";

export interface LangFnConfig {
  model: ChatModel;
  observability?: {
    enabled?: boolean;
    watchfn?: any;
  };
}

export class LangFn {
  private model: ChatModel;
  private config: LangFnConfig;

  constructor(config: LangFnConfig) {
    this.model = config.model;
    this.config = config;
  }

  async complete<T extends z.ZodType>(
    prompt: string, 
    options: { metadata?: Record<string, any>, structured?: StructuredOutput<T> } = {}
  ): Promise<CompletionResponse & { parsed?: z.infer<T> }> {
    // Check cache
    const cache = (this as any)._cache;
    if (cache) {
       const cached = await cache.get(prompt, this.model.model, this.model.provider, options.metadata);
       if (cached) {
          if (options.structured) {
             const parsed = options.structured.parse(cached.content);
             return { ...cached, parsed };
          }
          return cached;
       }
    }

    const result = await this.model.complete({ prompt, ...options });
    
    // Set cache
    if (cache) {
       await cache.set(prompt, this.model.model, this.model.provider, result, options.metadata);
    }

    if (options.structured) {
      const parsed = options.structured.parse(result.content);
      return { ...result, parsed };
    }

    return result;
  }

  async chat<T extends z.ZodType>(
    messages: Message[], 
    options: { 
      tools?: Tool<any, any>[], 
      tool_choice?: string | object, 
      metadata?: Record<string, any>,
      structured?: StructuredOutput<T>
    } = {}
  ): Promise<ChatResponse & { parsed?: z.infer<T> }> {
    const result = await this.model.chat({ 
      messages, 
      tools: options.tools?.map(t => t.json_schema()),
      tool_choice: options.tool_choice,
      ...options 
    });

    if (options.structured) {
      const parsed = options.structured.parse(result.message.content);
      return { ...result, parsed };
    }

    return result;
  }

  async feedback(traceId: string, options: { rating: number, comment?: string, metadata?: Record<string, any> }): Promise<void> {
    if (this.config.observability?.enabled && this.config.observability?.watchfn) {
      this.config.observability.watchfn.track("feedback", {
        traceId,
        rating: options.rating,
        comment: options.comment,
        metadata: options.metadata || {}
      });
    }
  }

  async *stream(prompt: string, options: { metadata?: Record<string, any> } = {}): AsyncIterable<StreamEvent> {
    yield* this.model.stream({ prompt, ...options });
  }

  async *streamSSE(prompt: string): AsyncIterable<string> {
    const { toSSE } = await import("./streaming/sse.js");
    yield* toSSE(this, prompt);
  }

  async completeBatch(prompts: string[], options: { concurrency?: number, metadata?: Record<string, any> } = {}): Promise<CompletionResponse[]> {
    const concurrency = options.concurrency ?? 5;
    const results: CompletionResponse[] = [];
    
    // Simple batching with concurrency limit
    for (let i = 0; i < prompts.length; i += concurrency) {
      const batch = prompts.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(p => this.complete(p, options)));
      results.push(...batchResults);
    }

    return results;
  }

  async embed(texts: string | string[]): Promise<number[] | number[][]> {
    const { OpenAIEmbeddings } = await import("./rag/openai.js");
    const { OpenAIChatModel } = await import("./models/openai.js");
    
    // Auto-configure OpenAI embeddings if using OpenAI chat model
    if (!(this as any)._embeddings && this.model instanceof OpenAIChatModel) {
       (this as any)._embeddings = new OpenAIEmbeddings({
          apiKey: (this.model as any).apiKey,
          baseUrl: (this.model as any).baseUrl
       });
    }

    const embeddings = (this as any)._embeddings;
    if (!embeddings) throw new Error("Embeddings not configured");

    if (typeof texts === "string") {
      return embeddings.embedQuery(texts);
    }
    return embeddings.embedDocuments(texts);
  }

  async createReactAgent(tools: Tool<any, any>[], options: { max_iterations?: number, system_prompt?: string } = {}) {
    const { ReActAgent } = await import("./agents/react.js");
    return new ReActAgent({
      model: this,
      tools,
      ...options
    });
  }

  async createToolAgent(tools: Tool<any, any>[], options: { max_iterations?: number } = {}) {
    const { ToolAgent } = await import("./agents/tool_agent.js");
    return new ToolAgent({
      lang: this,
      tools,
      ...options
    });
  }

  // To be implemented: chains, etc.
}

export function langfn(config: LangFnConfig): LangFn {
  return new LangFn(config);
}
