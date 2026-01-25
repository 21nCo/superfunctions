export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

export interface Cost {
  prompt: number;
  completion: number;
  total: number;
  currency: string;
}

export interface ChatRequest {
  messages: Message[];
  tools?: any[];
  tool_choice?: string | object;
  metadata?: Record<string, any>;
}

export interface ChatResponse {
  message: Message;
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
  cost?: Cost;
  trace_id?: string;
  raw?: any;
}

export interface CompletionRequest {
  prompt: string;
  metadata?: Record<string, any>;
}

export interface CompletionResponse {
  content: string;
  usage?: TokenUsage;
  cost?: Cost;
  trace_id?: string;
  raw?: any;
}

export type StreamEvent = ContentEvent | EndEvent | ErrorEvent;

export interface ContentEvent {
  type: "content";
  content: string;
  delta: string;
  trace_id?: string;
}

export interface EndEvent {
  type: "end";
  finish_reason: string;
  trace_id?: string;
}

export interface ErrorEvent {
  type: "error";
  error: any;
  trace_id?: string;
}
