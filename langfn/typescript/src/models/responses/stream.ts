import { LangFnError, ProviderError } from "../../core/errors.js";
import type { StreamEvent } from "../../core/types.js";
import { type BodyErrorState, readStreamLines } from "../stream-lines.js";
import { OutputLedger } from "./ledger.js";
import {
  assertNoReportedError,
  describeWireValue,
  parseResponsesResponse,
  reportsIncompleteDetails,
  responseId,
  responsesError,
  terminalStatus,
  type ParseResponsesOptions,
} from "./response.js";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/** The UTF-8 byte length of a string, without encoding it. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Parse server-sent events: multi-line data, LF, CRLF or CR line endings and comment lines.
 * The byte limit (`maxLineBytes`, 1 MiB by default) bounds each line and also each event's
 * accumulated data (its data lines and the line feeds that join them), so a frame of many
 * short data lines cannot grow without bound: crossing it is RESPONSE_TOO_LARGE and cancels the
 * read. An event whose data is empty carries nothing to parse and is not dispatched.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  maxLineBytes?: number,
  options: { bodyError?: BodyErrorState } = {},
): AsyncIterable<ServerSentEvent> {
  const maxFrameBytes = maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  let data: string[] = [];
  let frameBytes = 0;
  let event: string | undefined;
  // Lines split incrementally on LF, CRLF or a bare CR, and the byte limit applies per line.
  for await (const line of readStreamLines(body, maxLineBytes, { crLineBreaks: true, bodyError: options.bodyError })) {
    if (line === "") {
      const joined = data.join("\n");
      if (joined) yield { ...(event !== undefined ? { event } : {}), data: joined };
      data = [];
      frameBytes = 0;
      event = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      // Leaving the loop by this throw cancels the read (readStreamLines releases the body).
      frameBytes += utf8Length(value) + (data.length ? 1 : 0);
      if (frameBytes > maxFrameBytes) {
        throw new LangFnError("Provider stream event exceeds byte limit", { code: "RESPONSE_TOO_LARGE" });
      }
      data.push(value);
    } else if (field === "event") event = value;
  }
  // An event without its terminating blank line is incomplete and is discarded, as WHATWG
  // server-sent events require.
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A stated output_index (or other index): absent or null is none, anything else a non-negative integer. */
function outputIndex(
  value: unknown,
  event: string,
  fail: (message: string) => ProviderError,
  field = "output_index",
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw fail(`Responses ${event} ${field} must be a non-negative integer`);
  }
  return value;
}

/** A stated item_id: absent or null is none, anything else a non-empty string. */
function itemId(value: unknown, event: string, fail: (message: string) => ProviderError): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value) throw fail(`Responses ${event} item_id must be a non-empty string`);
  return value;
}

/** Events whose response envelope must describe a running response. */
const LIFECYCLE_EVENTS = new Set(["response.created", "response.queued", "response.in_progress"]);
/** Events that end the turn: success (judged at the terminal) or failure. */
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete"]);
const CANCELLED_EVENTS = new Set(["response.cancelled", "response.canceled"]);

/**
 * Raise the provider error a frame reports, if any, whatever its event type: the error on its
 * response (the response's own outcome), else the error on the event, else, for a frame named
 * `error`, the flat `{ type: "error", code, message }` shape. An absent, null or empty `{}`
 * error reports nothing, so the next envelope decides. Rate-limit, auth and context-length
 * errors keep their typed classes.
 */
function assertNoFrameError(payload: JsonRecord, flat: boolean, provider: string): void {
  if (isRecord(payload.response)) assertNoReportedError(payload.response, provider);
  assertNoReportedError(payload, provider);
  const populated = (value: unknown) => value !== undefined && value !== null && value !== "";
  if (flat && (populated(payload.code) || populated(payload.message))) {
    throw responsesError(provider, { body: payload, error: payload });
  }
}

/**
 * Judge a response envelope on any frame but the terminal one, by the rule every envelope uses
 * (terminalStatus): a lifecycle frame (created, queued, in_progress) must carry a response
 * object, and any envelope must describe a running response. A stated status other than queued
 * or in_progress (failed, completed, incomplete, cancelled, unknown, or none beside
 * incomplete_details) contradicts the success path that follows; a running turn has not been
 * truncated, so populated incomplete_details fail too, and malformed ones fail in
 * terminalStatus. A supplied response id is returned for the lifecycle id check.
 */
function runningEnvelopeId(payload: JsonRecord, type: string, provider: string): string | undefined {
  const fail = (message: string) => new ProviderError(message, { provider });
  const response = payload.response;
  if (response === undefined && !LIFECYCLE_EVENTS.has(type)) return undefined;
  if (!isRecord(response)) throw fail(`Responses ${type} event requires a response object`);
  const status = terminalStatus(response, provider);
  if (status !== undefined && status !== "queued" && status !== "in_progress") {
    // A populated error was raised already; a failure that names none is still a failure.
    if (status === "failed") throw responsesError(provider, { body: payload, error: {} });
    throw fail(`Responses ${type} event reports response status ${describeWireValue(status)}`);
  }
  if (reportsIncompleteDetails(response, provider)) {
    throw fail(`Responses ${type} event reports incomplete_details on a running response`);
  }
  return responseId(response, provider);
}

/**
 * Map Responses API stream events to LangFn stream events: text deltas to `content` and
 * reasoning summary and reasoning text deltas to `reasoning` as they arrive; then, from the
 * terminal response, `tool_call` for each finished function call, `token_usage`, the
 * replayable assistant `message` and `end`. Tool calls wait for the terminal event because a
 * call is only executable once the response completes: an incomplete response (for example
 * `max_output_tokens`) yields no tool calls and ends with `length`.
 *
 * Every event that names an output item merges into one ledger ({@link OutputLedger}), so an
 * item's announcement, deltas, finished form and terminal form must agree; the terminal output
 * (or the one rebuilt from the ledger when omitted), the tool calls and the answer text not
 * already streamed all derive from it. That text is delivered as one `content` event before the
 * tool calls, so a consumer that accumulates `content` sees the whole answer once.
 *
 * A stream that ends without a terminal event, reports a failure or cancellation, or whose
 * outcome is ambiguous throws a typed error before any tool call or end: an event name that
 * conflicts with the JSON type, a JSON type that is not a non-empty string, any populated error
 * on any frame or its response (which decides the typed class before any other check), an
 * envelope on a non-terminal frame that does not describe a running response, incomplete_details
 * beside a completed status, a different response id, a ledger conflict, or a returned call
 * reusing a call_id of the sent history (`options.sentCallIds`). An empty SSE event name or
 * `message` is the default event type and defers to the JSON type. Once the terminal response is
 * validated, the events are released (the body is no longer read) before its `tool_call`,
 * `token_usage`, `message` and `end` events are yielded.
 */
export async function* mapResponsesStream(
  events: AsyncIterable<ServerSentEvent>,
  provider: string,
  options: ParseResponsesOptions = {},
): AsyncIterable<StreamEvent> {
  const fail = (message: string) => new ProviderError(message, { provider });
  const ledger = new OutputLedger(fail, provider);
  let startedId: string | undefined;
  let terminal: StreamEvent[] | undefined;

  frames: for await (const frame of events) {
    if (frame.data === "[DONE]") break;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch (error) {
      throw new ProviderError("Responses stream event is not valid JSON", { provider, cause: error });
    }
    if (!isRecord(payload)) throw fail("Responses stream event must be a JSON object");
    // The discriminator may appear in the SSE event name, the JSON type or both. An empty event
    // name or "message" is the WHATWG default event type, which names nothing, so the JSON type
    // decides. A JSON type must be a non-empty string. When both are present they must agree,
    // whatever event they name, or the frame is ambiguous.
    const eventName = frame.event === "" || frame.event === "message" ? undefined : frame.event;
    // A reported error on any frame (a lifecycle or delta event, a data-only gateway frame, one
    // with a malformed type) is the outcome, typed, before anything the frame or a later one
    // would yield, and before the frame's discriminator is judged.
    assertNoFrameError(payload, payload.type === "error" || eventName === "error", provider);
    if (payload.type !== undefined && (typeof payload.type !== "string" || !payload.type)) {
      throw fail("Responses stream event type must be a non-empty string");
    }
    const jsonType = payload.type as string | undefined;
    if (jsonType !== undefined && eventName !== undefined && eventName !== jsonType) {
      throw fail(`Responses stream event ${eventName} conflicts with its type ${jsonType}`);
    }
    const type = jsonType ?? eventName ?? "";

    if (!TERMINAL_EVENTS.has(type)) {
      // Every envelope before the terminal one describes the same running response.
      const id = runningEnvelopeId(payload, type, provider);
      if (id !== undefined) {
        if (startedId !== undefined && startedId !== id) throw fail(`Responses stream changed its response id from ${startedId} to ${id}`);
        startedId = id;
      }
    }

    switch (type) {
      case "response.output_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses text delta must be a string");
        const item = itemId(payload.item_id, "output_text.delta", fail);
        const index = outputIndex(payload.output_index, "output_text.delta", fail);
        const contentIndex = outputIndex(payload.content_index, "output_text.delta", fail, "content_index");
        if (payload.delta) {
          ledger.text(item, index, contentIndex, payload.delta);
          yield { type: "content", content: payload.delta, delta: payload.delta };
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses reasoning delta must be a string");
        const step = type === "response.reasoning_text.delta" ? "content" : "summary";
        if (payload.delta) yield { type: "reasoning", step, thinking: payload.delta };
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        const what = type.slice("response.".length);
        const item = itemId(payload.item_id, what, fail);
        const index = outputIndex(payload.output_index, what, fail);
        if (type === "response.function_call_arguments.delta") {
          if (typeof payload.delta !== "string") throw fail("Responses function_call_arguments.delta requires a string delta");
          if (payload.delta) ledger.argumentsDelta(item, index, payload.delta);
        } else {
          if (typeof payload.arguments !== "string") throw fail("Responses function_call_arguments.done requires arguments");
          ledger.argumentsDone(item, index, payload.arguments);
        }
        break;
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        const what = type.slice("response.".length);
        if (!isRecord(payload.item)) throw fail(`Responses ${what} requires an item`);
        const index = outputIndex(payload.output_index, what, fail);
        if (type === "response.output_item.added") ledger.announce(payload.item, index);
        else ledger.finish(payload.item, index);
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        // A reported error on the event or its response was judged above.
        const response = payload.response;
        if (!isRecord(response)) throw fail(`Responses ${type} event requires a response`);
        // Some compatible servers omit the output (or send it empty) in the terminal event;
        // only then is it rebuilt from the ledger. Any other non-array output, including null,
        // is malformed and fails in parseResponsesResponse, as it does for a JSON response.
        const omitted = response.output === undefined
          || (Array.isArray(response.output) && response.output.length === 0);
        // The response's status comes from the rule a JSON response uses (terminalStatus): a
        // null status is none, and populated incomplete_details make a missing status
        // incomplete and a completed one a contradiction. The event type fills only a status
        // that is still absent. An explicit failed status raises its typed error in
        // parseResponsesResponse; any other status must match the event, so a
        // response.incomplete event, or a response that reports truncation, never yields
        // executable calls.
        const eventStatus = type === "response.incomplete" ? "incomplete" : "completed";
        const responseStatus = terminalStatus(response, provider);
        if (responseStatus !== undefined && responseStatus !== "failed" && responseStatus !== eventStatus) {
          throw fail(`Responses ${type} event conflicts with its response status ${describeWireValue(responseStatus)}`);
        }
        const status = responseStatus ?? eventStatus;
        // A supplied response id is a non-empty string, and the lifecycle and terminal ids agree.
        const terminalId = responseId(response, provider);
        if (startedId !== undefined && terminalId !== undefined && terminalId !== startedId) {
          throw fail(`Responses ${type} event is for response ${terminalId}, not ${startedId}`);
        }
        let output: unknown = response.output;
        let undelivered = "";
        if (status !== "failed") {
          ({ output, undelivered } = ledger.resolve({ output: response.output, omitted, completed: status === "completed", type }));
        }
        const result = parseResponsesResponse({ ...response, status, output }, provider, options);
        terminal = [];
        if (undelivered) terminal.push({ type: "content", content: undelivered, delta: undelivered });
        for (const call of result.toolCalls ?? []) {
          terminal.push({ type: "tool_call", id: call.id, toolName: call.name, args: call.arguments });
        }
        if (result.usage) {
          terminal.push({
            type: "token_usage",
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          });
        }
        terminal.push({ type: "message", message: result.message });
        terminal.push({ type: "end", finish_reason: result.finishReason });
        break frames;
      }
      case "response.failed":
      case "error":
        // A populated error was raised above; a failure that names none is still a failure.
        throw responsesError(provider, { body: payload, error: {} });
      default:
        // A cancelled response is never a success, whatever its envelope says.
        if (CANCELLED_EVENTS.has(type)) throw fail(`Responses stream reports ${type}`);
        // Other lifecycle and *.done events carry no new data for LangFn stream events.
        break;
    }
  }
  if (!terminal) throw fail("Responses stream ended before a terminal response event");
  // Leaving the frame loop has already released the body (which cancels the read and clears a
  // transport deadline), so the fully received turn is delivered whatever the body would do next.
  yield* terminal;
}
