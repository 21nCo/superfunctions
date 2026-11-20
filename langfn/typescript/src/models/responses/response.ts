import {
  ContextLengthError,
  LangFnError,
  ProviderAuthError,
  ProviderError,
  RateLimitError,
} from "../../core/errors.js";
import type { ToolCall } from "../../core/types.js";
import { providerUsage } from "../../core/usage.js";
import type {
  ResponsesChatResponse,
  ResponsesFinishReason,
  ResponsesMessage,
  ResponsesOutputItem,
  ResponsesReasoningSummary,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface ParsedOutputItems {
  content: string;
  refusal?: string;
  toolCalls: ToolCall[];
  reasoning: ResponsesReasoningSummary[];
}

/** Read the text, refusal, function calls and reasoning out of Responses output items. */
export function parseOutputItems(output: unknown, provider: string): ParsedOutputItems {
  const fail = (message: string) => new ProviderError(message, { provider });
  if (!Array.isArray(output)) throw fail("Responses output must be an array");
  const text: string[] = [];
  const refusals: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoning: ResponsesReasoningSummary[] = [];

  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== "string") throw fail("Responses output item is malformed");
    switch (item.type) {
      case "message": {
        if (item.role !== undefined && item.role !== "assistant") throw fail("Responses output message must be from the assistant");
        if (!Array.isArray(item.content)) throw fail("Responses output message content must be an array");
        for (const part of item.content) {
          if (!isRecord(part) || typeof part.type !== "string") throw fail("Responses output content part is malformed");
          if (part.type === "output_text") {
            if (typeof part.text !== "string") throw fail("Responses output_text part requires text");
            text.push(part.text);
          } else if (part.type === "refusal") {
            if (typeof part.refusal !== "string") throw fail("Responses refusal part requires refusal text");
            refusals.push(part.refusal);
          }
        }
        break;
      }
      case "function_call":
        toolCalls.push(parseFunctionCall(item, provider));
        break;
      case "reasoning":
        reasoning.push(parseReasoning(item, provider));
        break;
      default:
        // Other item types are kept in responsesOutput but carry no chat content.
        break;
    }
  }
  return {
    content: text.join(""),
    ...(refusals.length ? { refusal: refusals.join("") } : {}),
    toolCalls,
    reasoning,
  };
}

export function parseFunctionCall(item: JsonRecord, provider: string): ToolCall {
  const fail = (message: string) => new ProviderError(message, { provider });
  if (typeof item.call_id !== "string" || !item.call_id) throw fail("Responses function_call requires call_id");
  if (typeof item.name !== "string" || !item.name) throw fail("Responses function_call requires name");
  if (typeof item.arguments !== "string") throw fail("Responses function_call arguments must be a JSON string");
  let args: unknown;
  try {
    args = item.arguments.trim() ? JSON.parse(item.arguments) : {};
  } catch (error) {
    throw new ProviderError("Responses function_call arguments are not valid JSON", { provider, cause: error });
  }
  if (!isRecord(args)) throw fail("Responses function_call arguments must be a JSON object");
  return { id: item.call_id, name: item.name, arguments: args };
}

function parseReasoning(item: JsonRecord, provider: string): ResponsesReasoningSummary {
  const fail = (message: string) => new ProviderError(message, { provider });
  const texts = (value: unknown, field: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw fail(`Responses reasoning ${field} must be an array`);
    return value.map((part) => {
      if (!isRecord(part) || typeof part.text !== "string") throw fail(`Responses reasoning ${field} part requires text`);
      return part.text;
    });
  };
  if (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== "string") {
    throw fail("Responses reasoning encrypted_content must be a string");
  }
  return {
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    summary: texts(item.summary, "summary"),
    content: texts(item.content, "content"),
    encrypted: typeof item.encrypted_content === "string" && item.encrypted_content.length > 0,
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stable(value[key])]),
  );
}

export function sameToolCalls(left: ToolCall[], right: ToolCall[]): boolean {
  const canonical = (calls: ToolCall[]) => JSON.stringify(stable(calls.map(({ id, name, arguments: args }) => ({ id, name, args }))));
  return canonical(left) === canonical(right);
}

/** Map a complete Responses API response object (non-streaming or the terminal stream event). */
export function parseResponsesResponse(data: unknown, provider: string): ResponsesChatResponse {
  if (!isRecord(data)) throw new ProviderError("Responses body must be a JSON object", { provider });
  const status = data.status;
  if (status === "failed" || (status === undefined && isRecord(data.error))) {
    throw responsesError(provider, { status: 200, body: data, error: data.error });
  }
  if (status !== undefined && status !== "completed" && status !== "incomplete") {
    throw new ProviderError(`Responses returned unexpected status ${String(status)}`, { provider, metadata: { status } });
  }

  const parsed = parseOutputItems(data.output, provider);
  const usage = isRecord(data.usage)
    ? providerUsage(data.usage.input_tokens, data.usage.output_tokens, data.usage.total_tokens)
    : undefined;

  let finishReason: ResponsesFinishReason;
  if (status === "incomplete") {
    const reason = isRecord(data.incomplete_details) ? data.incomplete_details.reason : undefined;
    finishReason = reason === "max_output_tokens" ? "length" : typeof reason === "string" && reason ? reason : "incomplete";
  } else if (parsed.toolCalls.length) {
    finishReason = "tool_calls";
  } else if (parsed.refusal !== undefined && !parsed.content) {
    finishReason = "refusal";
  } else {
    finishReason = "stop";
  }

  const toolCalls = parsed.toolCalls.length ? parsed.toolCalls : undefined;
  const message: ResponsesMessage = {
    role: "assistant",
    content: parsed.content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(parsed.refusal !== undefined ? { refusal: parsed.refusal } : {}),
    responsesOutput: structuredClone(data.output as ResponsesOutputItem[]),
  };
  return {
    message,
    ...(toolCalls ? { toolCalls, tool_calls: toolCalls } : {}),
    ...(usage ? { usage } : {}),
    finishReason,
    reasoning: parsed.reasoning,
    ...(typeof data.id === "string" ? { responseId: data.id } : {}),
    raw: data,
  };
}

const CONTEXT_PATTERN = /maximum context length|context[ _]length|context window/i;

/**
 * Classify a provider error. Handles OpenAI (`{ error: { code: "rate_limit_exceeded" } }`),
 * OpenRouter (`{ error: { code: 429, message } }`) and stream `error` events.
 */
export function responsesError(
  provider: string,
  details: { status?: number; body: unknown; error?: unknown; retryAfter?: number },
): LangFnError {
  const error = isRecord(details.error) ? details.error : isRecord(details.body) && isRecord(details.body.error) ? details.body.error : undefined;
  const code = error?.code ?? error?.type;
  const message = typeof error?.message === "string" ? error.message : "";
  const metadata: JsonRecord = { body: details.body };
  if (details.status !== undefined) metadata.status = details.status;
  if (code !== undefined) metadata.providerCode = code;

  if (details.status === 401 || code === "invalid_api_key" || code === 401) {
    return new ProviderAuthError(undefined, { provider, metadata });
  }
  if (details.status === 429 || code === "rate_limit_exceeded" || code === 429) {
    return new RateLimitError(undefined, { provider, retryAfter: details.retryAfter, metadata });
  }
  if (code === "context_length_exceeded" || ((details.status === undefined || details.status === 200 || details.status === 400 || details.status === 413 || code === 400) && CONTEXT_PATTERN.test(message))) {
    return new ContextLengthError(undefined, { provider, metadata });
  }
  const label = details.status !== undefined && details.status !== 200 ? ` (${details.status})` : "";
  return new ProviderError(`${provider} Responses request failed${label}${message ? `: ${message}` : ""}`, { provider, metadata });
}

/** Throw the classified error for a non-2xx HTTP response. */
export async function raiseForResponsesStatus(provider: string, response: Response): Promise<void> {
  if (response.ok) return;
  const retryAfter = parseRetryAfter(response.headers);
  let text = "";
  try {
    text = await response.text();
  } catch {
    // An unreadable error body still yields a typed status error.
  }
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Keep the text body.
  }
  throw responsesError(provider, { status: response.status, body, retryAfter });
}

function parseRetryAfter(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms")?.trim();
  if (milliseconds) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) return value / 1_000;
  }
  const normalized = headers.get("retry-after")?.trim();
  if (!normalized) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, (retryAt - Date.now()) / 1_000);
}
