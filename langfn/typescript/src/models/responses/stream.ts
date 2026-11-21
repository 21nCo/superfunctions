import { ProviderError } from "../../core/errors.js";
import type { StreamEvent } from "../../core/types.js";
import { type BodyErrorState, readStreamLines } from "../stream-lines.js";
import {
  assertNoReportedError,
  parseFunctionCall,
  parseResponsesResponse,
  responsesError,
  type ParseResponsesOptions,
} from "./response.js";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

/** Parse server-sent events: multi-line data, LF, CRLF or CR line endings and comment lines. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  maxLineBytes?: number,
  options: { bodyError?: BodyErrorState } = {},
): AsyncIterable<ServerSentEvent> {
  let data: string[] = [];
  let event: string | undefined;
  // Lines split incrementally on LF, CRLF or a bare CR, and the byte limit applies per line.
  for await (const line of readStreamLines(body, maxLineBytes, { crLineBreaks: true, bodyError: options.bodyError })) {
    if (line === "") {
      if (data.length) yield { ...(event !== undefined ? { event } : {}), data: data.join("\n") };
      data = [];
      event = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  // An event without its terminating blank line is incomplete and is discarded, as WHATWG
  // server-sent events require.
}

type JsonRecord = Record<string, unknown>;

interface ArgumentsDone {
  itemId?: string;
  index?: number;
  arguments: string;
}

interface DoneEntry {
  item: JsonRecord;
  /** The output_index the provider stated; arrival order never stands in for it. */
  index?: number;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The output a terminal event without one (absent or `[]`) stands for: the finished items, in
 * their stated output_index order when every item states one, otherwise in arrival order.
 */
function rebuildOutput(done: DoneEntry[]): JsonRecord[] {
  const entries = done.every((entry) => entry.index !== undefined)
    ? [...done].sort((left, right) => (left.index as number) - (right.index as number))
    : done;
  return entries.map((entry) => entry.item);
}

/**
 * Reconcile what the stream already reported as finished with the terminal output, as one
 * ledger, before any tool call, message or end:
 * - A non-empty terminal output names each item id, and each function_call call_id, once;
 *   the finished items do too.
 * - Each finished output_item.done item maps to exactly one terminal item: by its stated
 *   output_index, else by its id, else by its call_id. Every identity both carry (type, id,
 *   call_id) agrees, and a function call keeps its name and arguments. A finished item with
 *   an id or a call_id that maps to nothing fails, whatever its type; only an unindexed item
 *   with neither is exempt. With an omitted output the finished items are the output.
 * - In a completed stream a finished call must be executable, as the terminal output must be.
 * - Each function_call_arguments.done resolves to exactly one function call, whose arguments
 *   it repeats: item_id by id in the ledger, output_index by terminal position (or by stated
 *   index when the output is omitted), and both locators must name the same call.
 */
function reconcileFinishedItems(state: {
  done: DoneEntry[];
  argumentsDone: ArgumentsDone[];
  output: unknown;
  omitted: boolean;
  completed: boolean;
  fail: (message: string) => ProviderError;
  provider: string;
}): void {
  const { done, argumentsDone, output, omitted, completed, fail, provider } = state;
  // A malformed terminal output fails in parseResponsesResponse.
  if (!Array.isArray(output)) return;

  const uniqueIdentities = (items: JsonRecord[], what: string) => {
    const ids = new Set<string>();
    const callIds = new Set<string>();
    for (const item of items) {
      if (nonEmptyString(item.id)) {
        if (ids.has(item.id)) throw fail(`Responses ${what} repeats item id ${item.id}`);
        ids.add(item.id);
      }
      if (item.type === "function_call" && nonEmptyString(item.call_id)) {
        if (callIds.has(item.call_id)) throw fail(`Responses ${what} repeats function_call call_id ${item.call_id}`);
        callIds.add(item.call_id);
      }
    }
  };
  uniqueIdentities(done.map((entry) => entry.item), "output_item.done");
  const terminal = output.filter(isRecord);
  if (!omitted) uniqueIdentities(terminal, "terminal output");

  const claimed = new Set<JsonRecord>();
  for (const { item, index } of done) {
    const label = String(item.call_id ?? item.id ?? index ?? item.type);
    if (item.type === "function_call" && completed) {
      if (!(item.status === undefined || item.status === null || item.status === "completed")) {
        throw fail("Responses completed stream finished an unfinished function_call");
      }
      parseFunctionCall(item, provider);
    }
    if (omitted) continue;
    let match: JsonRecord | undefined;
    let where = "";
    if (index !== undefined) {
      const candidate = output[index];
      match = isRecord(candidate) ? candidate : undefined;
      where = ` at output_index ${index}`;
    } else if (nonEmptyString(item.id)) {
      match = terminal.find((candidate) => candidate.id === item.id);
    } else if (nonEmptyString(item.call_id)) {
      match = terminal.find((candidate) => candidate.call_id === item.call_id);
    } else {
      // Nothing identifies the item, so nothing can be checked against it.
      continue;
    }
    if (!match || match.type !== item.type) {
      throw fail(`Responses terminal output does not have the finished ${String(item.type)} item ${label}${where}`);
    }
    if (claimed.has(match)) throw fail(`Responses terminal output item for ${label} matches two finished items`);
    claimed.add(match);
    if (nonEmptyString(match.id) && nonEmptyString(item.id) && match.id !== item.id) {
      throw fail(`Responses terminal output replaced the finished item ${item.id}${where}`);
    }
    if (item.type === "function_call"
      ? match.call_id !== item.call_id || match.name !== item.name || match.arguments !== item.arguments
      : item.call_id !== undefined && match.call_id !== undefined && match.call_id !== item.call_id) {
      throw fail(`Responses terminal output changed the finished ${String(item.type)} ${label}`);
    }
  }

  // With an omitted output the finished items are the output; positions are the stated ones.
  const ledger = omitted ? done.map((entry) => entry.item) : terminal;
  const atIndex = (index: number): JsonRecord | undefined => {
    if (!omitted) return isRecord(output[index]) ? output[index] as JsonRecord : undefined;
    return done.find((entry) => entry.index === index)?.item;
  };
  for (const final of argumentsDone) {
    if (final.itemId === undefined && final.index === undefined) {
      throw fail("Responses function_call_arguments.done names no item");
    }
    const label = final.itemId ?? String(final.index);
    let resolved: JsonRecord | undefined;
    if (final.itemId !== undefined) {
      resolved = ledger.find((item) => item.id === final.itemId);
      if (!resolved) throw fail(`Responses function_call_arguments.done names an unknown item ${final.itemId}`);
    }
    if (final.index !== undefined) {
      const positioned = atIndex(final.index);
      if (!positioned) throw fail(`Responses function_call_arguments.done names an unknown output_index ${final.index}`);
      if (resolved && positioned !== resolved) {
        throw fail(`Responses function_call_arguments.done item ${final.itemId} is not at output_index ${final.index}`);
      }
      resolved = positioned;
    }
    if (resolved?.type !== "function_call" || resolved.arguments !== final.arguments) {
      throw fail(`Responses function_call_arguments.done arguments differ from item ${label}`);
    }
  }
}

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Map Responses API stream events to LangFn stream events: text deltas to `content` and
 * reasoning summary and reasoning text deltas to `reasoning` as they arrive; then, from the
 * terminal response, `tool_call` for each finished function call, `token_usage`, the
 * replayable assistant `message` and `end`. Tool calls wait for the terminal event because a
 * call is only executable once the response completes: an incomplete response (for example
 * `max_output_tokens`) yields no tool calls and ends with `length`. A stream that ends without
 * a terminal event, reports a failure, or whose terminal outcome is ambiguous (an event name
 * that conflicts with the JSON type, any populated error on the event or its response beside a
 * success status, two finished items on one output index) throws a typed error before any tool
 * call or end. So does a terminal response that disagrees with what the stream already
 * reported as finished (see {@link reconcileFinishedItems}), a different response id, or a
 * returned call reusing a call_id of the sent history (`options.sentCallIds`).
 */
export async function* mapResponsesStream(
  events: AsyncIterable<ServerSentEvent>,
  provider: string,
  options: ParseResponsesOptions = {},
): AsyncIterable<StreamEvent> {
  const fail = (message: string) => new ProviderError(message, { provider });
  const done: DoneEntry[] = [];
  const statedIndexes = new Set<number>();
  const argumentsDone: ArgumentsDone[] = [];
  let startedId: string | undefined;

  for await (const frame of events) {
    if (frame.data === "[DONE]") break;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch (error) {
      throw new ProviderError("Responses stream event is not valid JSON", { provider, cause: error });
    }
    if (!isRecord(payload)) throw fail("Responses stream event must be a JSON object");
    // The discriminator may appear in the SSE event name, the JSON type or both; when both
    // name a terminal event they must agree, or the outcome is ambiguous.
    const jsonType = typeof payload.type === "string" ? payload.type : undefined;
    if (jsonType !== undefined && frame.event !== undefined && frame.event !== jsonType
      && (TERMINAL_EVENTS.has(jsonType) || TERMINAL_EVENTS.has(frame.event))) {
      throw fail(`Responses stream event ${frame.event} conflicts with its type ${jsonType}`);
    }
    const type = jsonType ?? frame.event;

    switch (type) {
      case "response.output_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses text delta must be a string");
        if (payload.delta) yield { type: "content", content: payload.delta, delta: payload.delta };
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses reasoning delta must be a string");
        const step = type === "response.reasoning_text.delta" ? "content" : "summary";
        if (payload.delta) yield { type: "reasoning", step, thinking: payload.delta };
        break;
      }
      case "response.created":
      case "response.in_progress": {
        const id = isRecord(payload.response) ? payload.response.id : undefined;
        if (typeof id === "string") {
          if (startedId !== undefined && startedId !== id) throw fail(`Responses stream changed its response id from ${startedId} to ${id}`);
          startedId = id;
        }
        break;
      }
      case "response.function_call_arguments.done": {
        if (typeof payload.arguments !== "string") throw fail("Responses function_call_arguments.done requires arguments");
        const itemId = payload.item_id;
        const index = payload.output_index;
        if (itemId !== undefined && itemId !== null && typeof itemId !== "string") {
          throw fail("Responses function_call_arguments.done item_id must be a string");
        }
        if (index !== undefined && index !== null && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) {
          throw fail("Responses function_call_arguments.done output_index must be a non-negative integer");
        }
        argumentsDone.push({
          ...(typeof itemId === "string" ? { itemId } : {}),
          ...(typeof index === "number" ? { index } : {}),
          arguments: payload.arguments,
        });
        break;
      }
      case "response.output_item.done": {
        const item = payload.item;
        if (!isRecord(item)) throw fail("Responses output_item.done requires an item");
        const index = payload.output_index;
        if (index === undefined || index === null) {
          done.push({ item });
          break;
        }
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
          throw fail("Responses output_item.done output_index must be a non-negative integer");
        }
        // A repeated index would silently replace a finished item, and with it maybe a call.
        if (statedIndexes.has(index)) throw fail(`Responses output_item.done repeats output_index ${index}`);
        statedIndexes.add(index);
        done.push({ item, index });
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = payload.response;
        if (!isRecord(response)) throw fail(`Responses ${type} event requires a response`);
        // Some compatible servers omit the output (or send it empty) in the terminal event;
        // only then is it rebuilt from the finished items. Any other non-array output,
        // including null, is malformed and fails in parseResponsesResponse, as it does for a
        // JSON response.
        const omitted = response.output === undefined
          || (Array.isArray(response.output) && response.output.length === 0);
        const output = omitted ? rebuildOutput(done) : response.output;
        // The event type fills only an absent status. An explicit failed status raises its typed
        // error in parseResponsesResponse; any other explicit status must match the event, so a
        // response.incomplete event never yields executable calls.
        const eventStatus = type === "response.incomplete" ? "incomplete" : "completed";
        const explicitStatus = response.status;
        if (explicitStatus !== undefined && explicitStatus !== null && explicitStatus !== "failed" && explicitStatus !== eventStatus) {
          throw fail(`Responses ${type} event conflicts with its response status ${String(explicitStatus)}`);
        }
        const status = explicitStatus === undefined || explicitStatus === null ? eventStatus : explicitStatus;
        if (startedId !== undefined && typeof response.id === "string" && response.id !== startedId) {
          throw fail(`Responses ${type} event is for response ${response.id}, not ${startedId}`);
        }
        // A reported error, on the event or on its response, is the outcome, whatever the
        // stream finished before it.
        assertNoReportedError(payload, provider);
        assertNoReportedError(response, provider);
        if (status !== "failed") {
          reconcileFinishedItems({ done, argumentsDone, output, omitted, completed: status === "completed", fail, provider });
        }
        const result = parseResponsesResponse({ ...response, status, output }, provider, options);
        for (const call of result.toolCalls ?? []) {
          yield { type: "tool_call", id: call.id, toolName: call.name, args: call.arguments };
        }
        if (result.usage) {
          yield {
            type: "token_usage",
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          };
        }
        yield { type: "message", message: result.message };
        yield { type: "end", finish_reason: result.finishReason };
        return;
      }
      case "response.failed": {
        const response = isRecord(payload.response) ? payload.response : {};
        throw responsesError(provider, { body: payload, error: response.error });
      }
      case "error":
        throw responsesError(provider, { body: payload, error: isRecord(payload.error) ? payload.error : payload });
      default:
        // Lifecycle and *.done events carry no new data for LangFn stream events.
        break;
    }
  }
  throw fail("Responses stream ended before a terminal response event");
}
