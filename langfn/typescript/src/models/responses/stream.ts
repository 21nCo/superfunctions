import { ProviderError } from "../../core/errors.js";
import type { StreamEvent } from "../../core/types.js";
import { readStreamLines } from "../stream-lines.js";
import { assertNoReportedError, parseFunctionCall, parseResponsesResponse, responsesError } from "./response.js";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

/** Parse server-sent events: multi-line data, LF, CRLF or CR line endings and comment lines. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  maxLineBytes?: number,
): AsyncIterable<ServerSentEvent> {
  let data: string[] = [];
  let event: string | undefined;
  // Lines split incrementally on LF, CRLF or a bare CR, and the byte limit applies per line.
  for await (const line of readStreamLines(body, maxLineBytes, { crLineBreaks: true })) {
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

/**
 * Check that what the stream already reported as finished agrees with the terminal output.
 * An item finished at an explicit output_index has an item of the same type, and the same id
 * when both carry one, at that terminal index; a finished function call is in the terminal
 * output unchanged (call_id, name and arguments). Every locator of a
 * function_call_arguments.done resolves, both name the same function call, and its final
 * arguments match that call. In a completed stream a finished call must also be executable,
 * as parseResponsesResponse requires of the terminal output.
 */
function checkFinishedEvidence(state: {
  doneItems: Map<number, unknown>;
  explicitIndexes: Set<number>;
  argumentsDone: ArgumentsDone[];
  output: unknown;
  omitted: boolean;
  completed: boolean;
  fail: (message: string) => ProviderError;
  provider: string;
}): void {
  const { doneItems, explicitIndexes, argumentsDone, output, omitted, completed, fail, provider } = state;
  // A malformed terminal output fails in parseResponsesResponse.
  if (!Array.isArray(output)) return;
  const terminal = output.filter(isRecord);
  for (const [index, item] of doneItems) {
    if (!isRecord(item)) continue;
    const label = String(item.call_id ?? item.id ?? index);
    if (item.type === "function_call" && completed) {
      if (!(item.status === undefined || item.status === null || item.status === "completed")) {
        throw fail("Responses completed stream finished an unfinished function_call");
      }
      parseFunctionCall(item, provider);
    }
    if (omitted) continue;
    let match: JsonRecord | undefined;
    if (explicitIndexes.has(index)) {
      const candidate = output[index];
      match = isRecord(candidate) ? candidate : undefined;
      if (!match || match.type !== item.type) {
        throw fail(`Responses terminal output does not have the finished ${String(item.type)} item ${label} at output_index ${index}`);
      }
      if (typeof match.id === "string" && typeof item.id === "string" && match.id !== item.id) {
        throw fail(`Responses terminal output replaced the finished item ${item.id} at output_index ${index}`);
      }
    } else if (item.type === "function_call") {
      match = typeof item.call_id === "string"
        ? terminal.find((candidate) => candidate.type === "function_call" && candidate.call_id === item.call_id)
        : typeof item.id === "string"
          ? terminal.find((candidate) => candidate.type === "function_call" && candidate.id === item.id)
          : undefined;
      if (!match) throw fail(`Responses terminal output is missing the finished function_call ${label}`);
    }
    if (item.type === "function_call" && match
      && (match.call_id !== item.call_id || match.name !== item.name || match.arguments !== item.arguments)) {
      throw fail(`Responses terminal output changed the finished function_call ${label}`);
    }
  }
  const finished = [...doneItems.values(), ...(omitted ? [] : terminal)].filter(isRecord);
  for (const done of argumentsDone) {
    const label = done.itemId ?? String(done.index ?? "");
    if (done.itemId === undefined && done.index === undefined) {
      throw fail("Responses function_call_arguments.done names no item");
    }
    const byId = done.itemId !== undefined ? finished.filter((item) => item.id === done.itemId) : [];
    if (done.itemId !== undefined && !byId.length) throw fail(`Responses function_call_arguments.done names an unknown item ${done.itemId}`);
    const byIndex = done.index !== undefined
      ? [doneItems.get(done.index), omitted ? undefined : output[done.index]].filter(isRecord)
      : [];
    if (done.index !== undefined && !byIndex.length) throw fail(`Responses function_call_arguments.done names an unknown output_index ${done.index}`);
    if (done.itemId !== undefined && byIndex.some((item) => item.id !== done.itemId)) {
      throw fail(`Responses function_call_arguments.done item ${done.itemId} is not at output_index ${String(done.index)}`);
    }
    for (const item of [...byId, ...byIndex]) {
      if (item.type !== "function_call" || item.arguments !== done.arguments) {
        throw fail(`Responses function_call_arguments.done arguments differ from item ${label}`);
      }
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
 * that conflicts with the JSON type, any populated error beside a success status, two finished
 * items on one output index) throws a typed error before any tool call or end. So does a
 * terminal response that disagrees with what the stream already reported as finished: a
 * finished item missing from its output index or replaced there, a finished function call
 * missing or changed, final call arguments that differ or name no known call, or a
 * different response id.
 */
export async function* mapResponsesStream(
  events: AsyncIterable<ServerSentEvent>,
  provider: string,
): AsyncIterable<StreamEvent> {
  const fail = (message: string) => new ProviderError(message, { provider });
  const doneItems = new Map<number, unknown>();
  // Indexes the provider stated, as opposed to ones assigned in arrival order.
  const explicitIndexes = new Set<number>();
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
        const explicit = payload.output_index !== undefined && payload.output_index !== null;
        const index = explicit ? payload.output_index : doneItems.size;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
          throw fail("Responses output_item.done output_index must be a non-negative integer");
        }
        // A repeated index would silently replace a finished item, and with it maybe a call.
        if (doneItems.has(index)) throw fail(`Responses output_item.done repeats output_index ${index}`);
        doneItems.set(index, item);
        if (explicit) explicitIndexes.add(index);
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
        const output = omitted
          ? [...doneItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
          : response.output;
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
        // A reported error is the outcome, whatever the stream finished before it.
        assertNoReportedError(response, provider);
        if (status !== "failed") {
          checkFinishedEvidence({
            doneItems, explicitIndexes, argumentsDone, output, omitted, completed: status === "completed", fail, provider,
          });
        }
        const result = parseResponsesResponse({ ...response, status, output }, provider);
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
