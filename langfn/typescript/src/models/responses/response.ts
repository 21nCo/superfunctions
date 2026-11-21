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
   * The items a stateless follow-up can send back, unchanged except for required fields a
   * compatible server left out whose value is known (see {@link normalizeOutputItem}). Unfinished function calls (only
   * accepted in an incomplete response; a completed one with an unfinished call is rejected),
   * and the reasoning items that led into them, are left out: they are not executable, have no
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

/**
 * Item types that only exist as request input. A provider never returns them as output, and
 * `item_reference` resolves against stored server state, which `store: false` never has.
 */
const INPUT_ONLY_ITEM_TYPES = new Set([
  "item_reference",
  "function_call_output",
  "custom_tool_call_output",
  "computer_call_output",
  "local_shell_call_output",
  "shell_call_output",
  "apply_patch_call_output",
  "mcp_approval_response",
]);

/** Content part types that only exist in request input messages. */
const INPUT_ONLY_PART_TYPES = new Set(["input_text", "input_image", "input_file", "input_audio"]);

/**
 * Known content part types. One of them as a top-level output item is a part at the wrong
 * level, not a new item type, so it is rejected; unknown item types still pass.
 */
const PART_TYPES = new Set([...INPUT_ONLY_PART_TYPES, "output_text", "refusal", "summary_text", "reasoning_text"]);

/**
 * Known item types. One of them as a message content part is an item at the wrong level, not a
 * new part type, so it is rejected; unknown part types still pass.
 */
export const ITEM_TYPES = new Set([
  ...INPUT_ONLY_ITEM_TYPES,
  "message",
  "function_call",
  "reasoning",
  "custom_tool_call",
  "computer_call",
  "web_search_call",
  "file_search_call",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "shell_call",
  "apply_patch_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
]);

/**
 * Reasoning part types. They belong in a reasoning item's summary or content; inside an
 * assistant message they are a part at the wrong level whose text would be dropped.
 */
const REASONING_PART_TYPES = new Set(["summary_text", "reasoning_text"]);

const ITEM_STATUSES = new Set(["in_progress", "completed", "incomplete"]);

/**
 * Describe a wire value for an error message without trusting it: a string as it is, anything
 * else as JSON, and the type name when even that fails (a BigInt, a cycle, a throwing toJSON).
 */
export function describeWireValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

/** The identities of one Responses output item, validated. */
export interface OutputItemIdentity {
  type: string;
  id?: string;
  callId?: string;
}

/**
 * The one identity validator for Responses output items, wherever they arrive: a JSON
 * response, a terminal stream event, a finished stream item or a caller replay. An item is an
 * object with a non-empty string type; its id and call_id, when present (not absent or null), are
 * non-empty strings.
 */
export function outputItemIdentity(item: unknown, provider: string): OutputItemIdentity {
  const fail = (message: string) => new ProviderError(message, { provider });
  if (!isRecord(item) || typeof item.type !== "string" || !item.type) throw fail("Responses output item is malformed");
  const identity: OutputItemIdentity = { type: item.type };
  for (const [field, key] of [["id", "id"], ["call_id", "callId"]] as const) {
    const value = item[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw fail(`Responses output item ${field} must be a string`);
    if (!value) throw fail(`Responses output item ${field} must not be empty`);
    identity[key] = value;
  }
  return identity;
}

/**
 * Validate the identities of a list of output items: each item through
 * {@link outputItemIdentity}, and each item id, and each function_call call_id, named once.
 */
export function outputItemIdentities(items: unknown[], provider: string, what = "output"): OutputItemIdentity[] {
  const fail = (message: string) => new ProviderError(message, { provider });
  const identities = items.map((item) => outputItemIdentity(item, provider));
  const ids = new Set<string>();
  const callIds = new Set<string>();
  for (const identity of identities) {
    if (identity.id !== undefined) {
      if (ids.has(identity.id)) throw fail(`Responses ${what} repeats item id ${identity.id}`);
      ids.add(identity.id);
    }
    if (identity.type === "function_call" && identity.callId !== undefined) {
      if (callIds.has(identity.callId)) throw fail(`Responses ${what} repeats function_call call_id ${identity.callId}`);
      callIds.add(identity.callId);
    }
  }
  return identities;
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
  outputItemIdentities(output, provider);
  // Reasoning items at the end of `replayable` that precede the next output item.
  let trailingReasoning = 0;

  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== "string") throw fail("Responses output item is malformed");
    if (INPUT_ONLY_ITEM_TYPES.has(item.type)) throw fail(`Responses output must not contain ${item.type} items`);
    if (PART_TYPES.has(item.type)) throw fail(`Responses output item has the content part type ${item.type}`);
    switch (item.type) {
      case "message": {
        if (item.role !== undefined && item.role !== "assistant") throw fail("Responses output message must be from the assistant");
        if (item.status !== undefined && item.status !== null && !ITEM_STATUSES.has(item.status as string)) {
          throw fail(`Responses output message has unexpected status ${describeWireValue(item.status)}`);
        }
        if (!Array.isArray(item.content)) throw fail("Responses output message content must be an array");
        for (const part of item.content) {
          if (!isRecord(part) || typeof part.type !== "string" || !part.type) throw fail("Responses output content part is malformed");
          if (INPUT_ONLY_PART_TYPES.has(part.type)) throw fail(`Responses output message must not contain ${part.type} parts`);
          if (ITEM_TYPES.has(part.type)) throw fail(`Responses output content part has the item type ${part.type}`);
          if (REASONING_PART_TYPES.has(part.type)) throw fail(`Responses output message must not contain ${part.type} parts`);
          if (part.type === "output_text") {
            if (typeof part.text !== "string") throw fail("Responses output_text part requires text");
            if (part.annotations !== undefined && part.annotations !== null && !Array.isArray(part.annotations)) {
              throw fail("Responses output_text annotations must be an array");
            }
            if (Array.isArray(part.annotations) && !part.annotations.every(isRecord)) {
              throw fail("Responses output_text annotations must be objects");
            }
            text.push(part.text);
          } else if (part.type === "refusal") {
            if (typeof part.refusal !== "string") throw fail("Responses refusal part requires refusal text");
            refusals.push(part.refusal);
          }
        }
        break;
      }
      case "function_call":
        // A truncated call is never run or replayed, but its fields still have their wire types;
        // only its arguments may be cut short. A stated name is a non-empty string and stated
        // arguments a string (null included); call_id follows the identity rule.
        for (const field of ["call_id", "name", "arguments"]) {
          const value = item[field];
          if (value === undefined || (field === "call_id" && value === null)) continue;
          if (typeof value !== "string") throw fail(`Responses function_call ${field} must be a string`);
          if (field === "name" && !value) throw fail("Responses function_call name must not be empty");
        }
        if (item.status !== undefined && item.status !== null && !ITEM_STATUSES.has(item.status as string)) {
          throw fail(`Responses function_call has unexpected status ${describeWireValue(item.status)}`);
        }
        if (!options.incomplete) {
          // A completed turn whose call is still unfinished is contradictory: executing the
          // other calls alone, or reporting a normal stop, would hide the lost call.
          if (!isFinishedCall(item)) throw fail("Responses completed response contains an unfinished function_call");
          toolCalls.push(parseFunctionCall(item, provider));
          break;
        }
        // An unfinished call (truncated arguments) is neither executed nor replayed.
        replayable.splice(replayable.length - trailingReasoning, trailingReasoning);
        trailingReasoning = 0;
        continue;
      case "reasoning":
        reasoning.push(parseReasoning(item, provider));
        replayable.push(normalizeOutputItem(item));
        trailingReasoning += 1;
        continue;
      default:
        // Other item types are kept in responsesOutput but carry no chat content.
        break;
    }
    replayable.push(normalizeOutputItem(item));
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

/**
 * Fill the fields the Responses input schema requires on a replayed item when a compatible
 * server left them out and their value is known: an output message is from the assistant and
 * finished, its text parts have annotations, a reasoning item has a summary of summary_text
 * parts and no null status or content, a function call with a null status is finished, and a
 * null id is dropped. Fields that are present stay as they are, so a complete
 * item comes back unchanged; ids are never invented.
 */
export function normalizeOutputItem(item: JsonRecord): ResponsesOutputItem {
  const normalized = structuredClone(item) as ResponsesOutputItem;
  // A null id is no id; sending it back as null would be rejected.
  if (normalized.id === null) delete normalized.id;
  switch (normalized.type) {
    case "message":
      if (normalized.role === undefined) normalized.role = "assistant";
      if (normalized.status === undefined || normalized.status === null) normalized.status = "completed";
      if (Array.isArray(normalized.content)) {
        for (const part of normalized.content) {
          if (isRecord(part) && part.type === "output_text" && (part.annotations === undefined || part.annotations === null)) {
            part.annotations = [];
          }
        }
      }
      break;
    case "reasoning":
      // A null status or content is no value; sent back as null it would be rejected.
      if (normalized.status === null) delete normalized.status;
      if (normalized.content === null) delete normalized.content;
      if (normalized.summary === undefined || normalized.summary === null) normalized.summary = [];
      if (Array.isArray(normalized.summary)) {
        for (const part of normalized.summary) {
          if (isRecord(part) && part.type === undefined) part.type = "summary_text";
        }
      }
      // An untyped reasoning content part is reasoning text (parseReasoning admits no other),
      // and the input schema requires its type on replay.
      if (Array.isArray(normalized.content)) {
        for (const part of normalized.content) {
          if (isRecord(part) && part.type === undefined) part.type = "reasoning_text";
        }
      }
      break;
    case "function_call":
      if (normalized.status === null) normalized.status = "completed";
      break;
  }
  return normalized;
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
  // An executable call always carries a JSON object string ("{}" when it takes no arguments);
  // empty arguments mean the call was cut off, not that it has none.
  if (!item.arguments.trim()) throw fail("Responses function_call arguments must be a JSON object string, not empty");
  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
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
      const expected = field === "summary" ? "summary_text" : "reasoning_text";
      if (part.type !== undefined && part.type !== expected) {
        throw fail(`Responses reasoning ${field} part has unexpected type ${describeWireValue(part.type)}`);
      }
      return part.text;
    });
  };
  if (item.status !== undefined && item.status !== null && !ITEM_STATUSES.has(item.status as string)) {
    throw fail(`Responses reasoning item has unexpected status ${describeWireValue(item.status)}`);
  }
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

/**
 * A populated error wins over any status: a result that reports an error is never a success.
 * Only an absent error, null or `{}` count as no error. An error object raises its typed error;
 * any other value (such as a bare string) a ProviderError.
 */
export function assertNoReportedError(data: JsonRecord, provider: string): void {
  const error = data.error;
  if (error === undefined || error === null || (isRecord(error) && Object.keys(error).length === 0)) return;
  if (isRecord(error)) throw responsesError(provider, { status: 200, body: data, error });
  const detail = typeof error === "string" && error ? `: ${error}` : "";
  throw new ProviderError(`${provider} Responses request failed${detail}`, { provider, metadata: { status: 200, body: data } });
}

/**
 * Whether a response envelope reports a truncated turn: populated incomplete_details (not
 * absent, null or `{}`). Any other non-object value is malformed. Shared by every judge of an
 * envelope: a JSON response, a terminal stream event and a lifecycle frame.
 */
export function reportsIncompleteDetails(data: JsonRecord, provider: string): boolean {
  const details = data.incomplete_details;
  if (details !== undefined && details !== null && !isRecord(details)) {
    throw new ProviderError("Responses incomplete_details must be an object", { provider });
  }
  return isRecord(details) && Object.keys(details).length > 0;
}

/**
 * The one terminal status rule for a JSON response and a terminal stream event: a null status
 * is no status, and populated incomplete_details (not absent, null or `{}`) report a truncated
 * turn. With no status the turn is incomplete; beside a completed status it is a contradiction
 * (a call must not become executable on a turn that reports truncation). Any other status is
 * returned as it is, for the caller to judge.
 */
export function terminalStatus(data: JsonRecord, provider: string): unknown {
  const truncated = reportsIncompleteDetails(data, provider);
  const status = data.status === null ? undefined : data.status;
  if (status === undefined) return truncated ? "incomplete" : undefined;
  if (status === "completed" && truncated) {
    throw new ProviderError("Responses completed response reports incomplete_details", { provider, metadata: { status } });
  }
  return status;
}

/** A response id, when supplied (not absent or null), is a non-empty string. */
export function responseId(data: JsonRecord, provider: string): string | undefined {
  const id = data.id;
  if (id === undefined || id === null) return undefined;
  if (typeof id !== "string" || !id) throw new ProviderError("Responses response id must be a non-empty string", { provider });
  return id;
}

export interface ParseResponsesOptions {
  /**
   * Function call ids already in the history sent with the request. A tool agent runs every
   * returned call, so a returned call reusing one of them (a call that already ran) is rejected
   * instead of executed again.
   */
  sentCallIds?: ReadonlySet<string>;
}

/** Map a complete Responses API response object (non-streaming or the terminal stream event). */
export function parseResponsesResponse(
  data: unknown,
  provider: string,
  options: ParseResponsesOptions = {},
): ResponsesChatResponse {
  if (!isRecord(data)) throw new ProviderError("Responses body must be a JSON object", { provider });
  // A reported error is the outcome first; then one status rule, shared with the stream.
  assertNoReportedError(data, provider);
  const status = terminalStatus(data, provider);
  if (status === "failed") throw responsesError(provider, { status: 200, body: data, error: data.error });
  if (status !== undefined && status !== "completed" && status !== "incomplete") {
    throw new ProviderError(`Responses returned unexpected status ${describeWireValue(status)}`, { provider, metadata: { status } });
  }
  const id = responseId(data, provider);

  const parsed = parseOutputItems(data.output, provider, { incomplete: status === "incomplete" });
  for (const call of parsed.toolCalls) {
    if (options.sentCallIds?.has(call.id)) {
      throw new ProviderError(`Responses returned function_call call_id ${call.id}, which the sent history already used`, {
        provider,
        metadata: { callId: call.id },
      });
    }
  }
  // Only an absent or null usage is unknown; any other non-object report is invalid.
  if (data.usage !== undefined && data.usage !== null && !isRecord(data.usage)) {
    throw new LangFnError("Provider reported invalid token usage", { code: "INVALID_TOKEN_USAGE", provider });
  }
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
    // The replayed message keeps its own copy of the calls, apart from the ones a caller runs.
    ...(toolCalls ? { toolCalls: structuredClone(toolCalls) } : {}),
    ...(parsed.refusal !== undefined ? { refusal: parsed.refusal } : {}),
    responsesOutput: structuredClone(parsed.replayable),
  };
  return {
    message,
    ...(toolCalls ? { toolCalls, tool_calls: toolCalls } : {}),
    ...(usage ? { usage } : {}),
    finishReason,
    reasoning: parsed.reasoning,
    ...(id !== undefined ? { responseId: id } : {}),
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

  // An HTTP status that names the class wins; nested codes decide only when the status does
  // not (absent, a 200 stream or body error, or another status).
  const authError = () => new ProviderAuthError(undefined, { provider, metadata });
  const rateLimitError = () => new RateLimitError(undefined, { provider, retryAfter: details.retryAfter, metadata });
  if (details.status === 401) return authError();
  if (details.status === 429) return rateLimitError();
  if (code === "invalid_api_key" || code === 401) return authError();
  if (code === "rate_limit_exceeded" || code === 429) return rateLimitError();
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
    // A caller abort always wins. Otherwise a status that names the error class (401, 429)
    // decides whatever stopped the body read (a timeout, a transport error, an oversized body),
    // so retry policies still see the auth failure or the rate limit and its Retry-After; any
    // other status keeps a timed-out or oversized body's own error.
    if (isAbort(error, signal)) throw error;
    const classified = response.status === 401 || response.status === 429;
    if (!classified && error instanceof LangFnError) throw error;
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
