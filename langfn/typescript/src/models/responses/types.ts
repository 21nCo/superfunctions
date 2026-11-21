import type { ChatRequest, ChatResponse, Message } from "../../core/types.js";

/** An image input on a user message; needs the profile's `vision` capability. */
export interface ResponsesImageInput {
  /** An https URL or a data URL. */
  url: string;
  detail?: "auto" | "low" | "high";
}

/** A provider output item as returned by the Responses API (`message`, `function_call`, `reasoning`). */
export type ResponsesOutputItem = Record<string, unknown> & { type: string };

/**
 * A chat message accepted and returned by {@link ResponsesChatModel}. Assistant messages it
 * returns carry `responsesOutput`, the turn's provider items; keep the message in the
 * caller-supplied history and the items (including encrypted reasoning) are replayed on the
 * next stateless request.
 */
export interface ResponsesMessage extends Message {
  images?: ResponsesImageInput[];
  responsesOutput?: ResponsesOutputItem[];
  /** Refusal text from the model, when it declined to answer. */
  refusal?: string;
}

export type ResponsesTextFormat =
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      description?: string;
      strict?: boolean;
    }
  | { type: "json_object" };

export interface ResponsesReasoningConfig {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed";
}

export interface ResponsesChatRequest extends ChatRequest {
  messages: ResponsesMessage[];
  /** Structured output format; needs the profile's `structuredOutput` capability. */
  responseFormat?: ResponsesTextFormat;
  /** Reasoning configuration; needs the profile's `reasoning` capability. */
  reasoning?: ResponsesReasoningConfig;
  maxOutputTokens?: number;
  parallelToolCalls?: boolean;
}

export interface ResponsesReasoningSummary {
  id?: string;
  summary: string[];
  /** Raw reasoning text, when the provider returns it (some open-weight models through OpenRouter). */
  content: string[];
  /** Whether the item carries encrypted content that a stateless follow-up can replay. */
  encrypted: boolean;
}

export type ResponsesFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "refusal" | (string & {});

export interface ResponsesChatResponse extends ChatResponse {
  message: ResponsesMessage;
  finishReason: ResponsesFinishReason;
  reasoning: ResponsesReasoningSummary[];
  responseId?: string;
}
