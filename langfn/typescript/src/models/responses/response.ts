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
  /** Completed function calls; only these may be executed. */
  toolCalls: ToolCall[];
  reasoning: ResponsesReasoningSummary[];
  /**
   * The items a stateless follow-up can send back, unchanged. Unfinished function calls (and
   * the reasoning items that led into them) are left out: they are not executable, have no
   * function_call_output to pair with, and a reasoning item replayed without its following
   * item is rejected by the provider. For an incomplete response, reasoning at the end of the
   * output is left out for the same reason.
   */
  replayable: ResponsesOutputItem[];
}

export interface ParseOutputItemsOptions {
  /** The items come from an incomplete response, so none of its function calls are finished. */
  incomplete?: boolean;
}

/** Read the text, refusal, function calls and reasoning out of Responses output items. */
export function parseOutputItems(
  output: unknown,
  provider: string,
  options: ParseOutputItemsOptions = {},
): ParsedOutputItems {
  const fail = (message: string) => new ProviderError(message, { provider });
  if (!Array.isArray(output)) throw fail("Responses output must be an array");
  const text: string[] = [];
  const refusals: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoning: ResponsesReasoningSummary[] = [];
  const replayable: ResponsesOutputItem[] = [];
  // Reasoning items at the end of `replayable` that precede the next output item.
  let trailingReasoning = 0;

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
        if (!options.incomplete && isFinishedCall(item)) {
          toolCalls.push(parseFunctionCall(item, provider));
          break;
        }
        // An unfinished call (truncated arguments) is neither executed nor replayed.
        replayable.splice(replayable.length - trailingReasoning, trailingReasoning);
        trailingReasoning = 0;
        continue;
      case "reasoning":
        reasoning.push(parseReasoning(item, provider));
        replayable.push(item as ResponsesOutputItem);
        trailingReasoning += 1;
        continue;
      default:
        // Other item types are kept in responsesOutput but carry no chat content.
        break;
    }
    replayable.push(item as ResponsesOutputItem);
    trailingReasoning = 0;
  }
  // A turn cut off while reasoning has no item for its last reasoning to lead into.
  if (options.incomplete) replayable.splice(replayable.length - trailingReasoning, trailingReasoning);
  return {
    content: text.join(""),
    ...(refusals.length ? { refusal: refusals.join("") } : {}),
    toolCalls,
    reasoning,
    replayable,
  };
}

/** A function call is finished when its status is `completed`, or absent on servers that omit it. */
function isFinishedCall(item: JsonRecord): boolean {
  return item.status === undefined || item.status === null || item.status === "completed";
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

  const parsed = parseOutputItems(data.output, provider, { incomplete: status === "incomplete" });
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
    responsesOutput: structuredClone(parsed.replayable),
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

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

/**
 * Read a response body as text. Transport errors (a body timeout, an oversized body) and
 * aborts keep their identity so callers and retry policies can tell them apart.
 */
export async function readResponsesBody(provider: string, response: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (error instanceof LangFnError || isAbort(error, signal)) throw error;
    throw new ProviderError("Responses body could not be read", { provider, cause: error });
  }
}

/** Throw the classified error for a non-2xx HTTP response. */
export async function raiseForResponsesStatus(provider: string, response: Response, signal?: AbortSignal): Promise<void> {
  if (response.ok) return;
  const retryAfter = parseRetryAfter(response.headers);
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    // A timed-out, oversized or aborted body keeps its own error; any other unreadable error
    // body still yields a typed status error.
    if (error instanceof LangFnError || isAbort(error, signal)) throw error;
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
