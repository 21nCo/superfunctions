import { ProviderError } from "../../core/errors.js";
import type { StreamEvent } from "../../core/types.js";
import { type BodyErrorState, readStreamLines } from "../stream-lines.js";
import {
  assertNoReportedError,
  describeWireValue,
  outputItemIdentities,
  outputItemIdentity,
  parseFunctionCall,
  parseOutputItems,
  parseResponsesResponse,
  responseId,
  responsesError,
  terminalStatus,
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

/** An item the stream announced with output_item.added. */
interface AnnouncedEntry {
  type: string;
  id?: string;
  index?: number;
}

interface DoneEntry {
  item: JsonRecord;
  /** The output_index the provider stated; arrival order never stands in for it. */
  index?: number;
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
 * - The finished output_item.done items and a non-empty terminal output go through the same
 *   identity validator as a JSON response ({@link outputItemIdentities}): ids and call_ids are
 *   non-empty strings when present, and each item id, and each function_call call_id, is
 *   named once on each side.
 * - Each finished item maps to exactly one terminal item: by its stated output_index, else by
 *   the one terminal item sharing its id or call_id. No other terminal item may share one of
 *   its identities. Type agrees, every identity both carry (id, call_id) agrees, an identity
 *   only one side carries is accepted on that unique match, and a function call keeps its name
 *   and arguments. A finished item with an id or a call_id that maps to nothing fails,
 *   whatever its type; only an unindexed item with neither is exempt. With an omitted output
 *   the finished items are the output.
 * - In a completed stream a finished call must be executable, as the terminal output must be.
 * - Each function_call_arguments.done resolves to exactly one function call, whose arguments
 *   it repeats: item_id by the reconciled ids (the terminal item's own and those of the
 *   finished items mapped to it), output_index by terminal position (or by stated index when
 *   the output is omitted), and both locators must name the same call.
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

  const doneIdentities = outputItemIdentities(done.map((entry) => entry.item), provider, "output_item.done");
  const terminalIdentities = omitted ? doneIdentities : outputItemIdentities(output, provider, "terminal output");
  // The validator guarantees every item is an object.
  const ledger = (omitted ? done.map((entry) => entry.item) : output) as JsonRecord[];
  // The ids each ledger item answers to: its own and those of the finished items mapped to it.
  const ledgerIds = terminalIdentities.map((identity) => new Set(identity.id !== undefined ? [identity.id] : []));

  const claimed = new Set<number>();
  done.forEach(({ item, index }, position) => {
    const identity = doneIdentities[position];
    const label = identity.callId ?? identity.id ?? (index !== undefined ? String(index) : identity.type);
    if (identity.type === "function_call" && completed) {
      if (!(item.status === undefined || item.status === null || item.status === "completed")) {
        throw fail("Responses completed stream finished an unfinished function_call");
      }
      parseFunctionCall(item, provider);
    }
    if (omitted) return;
    const where = index !== undefined ? ` at output_index ${index}` : "";
    // Terminal items that share an identity with the finished item.
    const sharing: number[] = [];
    terminalIdentities.forEach((candidate, at) => {
      if ((identity.id !== undefined && candidate.id === identity.id)
        || (identity.callId !== undefined && candidate.callId === identity.callId)) sharing.push(at);
    });
    let at: number | undefined;
    if (index !== undefined) {
      if (index < ledger.length) at = index;
      if (at !== undefined && sharing.some((other) => other !== at)) {
        throw fail(`Responses terminal output moved the finished ${identity.type} item ${label} away from output_index ${index}`);
      }
    } else if (sharing.length > 1) {
      throw fail(`Responses terminal output has more than one item for the finished ${identity.type} item ${label}`);
    } else if (sharing.length === 1) {
      at = sharing[0];
    } else if (identity.id === undefined && identity.callId === undefined) {
      // Nothing identifies the item, so nothing can be checked against it.
      return;
    }
    if (at === undefined || terminalIdentities[at].type !== identity.type) {
      throw fail(`Responses terminal output does not have the finished ${identity.type} item ${label}${where}`);
    }
    if (claimed.has(at)) throw fail(`Responses terminal output item for ${label} matches two finished items`);
    claimed.add(at);
    const match = ledger[at];
    const matchIdentity = terminalIdentities[at];
    if (identity.id !== undefined && matchIdentity.id !== undefined && matchIdentity.id !== identity.id) {
      throw fail(`Responses terminal output replaced the finished item ${identity.id}${where}`);
    }
    if ((identity.callId !== undefined && matchIdentity.callId !== undefined && matchIdentity.callId !== identity.callId)
      || (identity.type === "function_call" && (match.name !== item.name || match.arguments !== item.arguments))) {
      throw fail(`Responses terminal output changed the finished ${identity.type} ${label}`);
    }
    if (identity.id !== undefined) ledgerIds[at].add(identity.id);
  });

  // Every finished item also passes the shape rules of a JSON output (an assistant message with
  // well-formed parts, a reasoning item with text parts, no input-only item), whether or not the
  // terminal event repeats it. This runs after the per-item checks above, so an unfinished or
  // malformed call keeps its own message.
  parseOutputItems(done.map((entry) => entry.item), provider, { incomplete: !completed });

  // With an omitted output the finished items are the output; positions are the stated ones.
  const atIndex = (index: number): number => {
    if (!omitted) return index < ledger.length ? index : -1;
    return done.findIndex((entry) => entry.index === index);
  };
  for (const final of argumentsDone) {
    if (final.itemId === undefined && final.index === undefined) {
      throw fail("Responses function_call_arguments.done names no item");
    }
    const label = final.itemId ?? String(final.index);
    let resolved: number | undefined;
    if (final.itemId !== undefined) {
      const itemId = final.itemId;
      const named: number[] = [];
      ledgerIds.forEach((ids, at) => {
        if (ids.has(itemId)) named.push(at);
      });
      if (!named.length) throw fail(`Responses function_call_arguments.done names an unknown item ${itemId}`);
      if (named.length > 1) throw fail(`Responses function_call_arguments.done item ${itemId} names more than one item`);
      resolved = named[0];
    }
    if (final.index !== undefined) {
      const positioned = atIndex(final.index);
      if (positioned < 0) throw fail(`Responses function_call_arguments.done names an unknown output_index ${final.index}`);
      if (resolved !== undefined && positioned !== resolved) {
        throw fail(`Responses function_call_arguments.done item ${final.itemId} is not at output_index ${final.index}`);
      }
      resolved = positioned;
    }
    const target = resolved === undefined ? undefined : ledger[resolved];
    if (target?.type !== "function_call" || target.arguments !== final.arguments) {
      throw fail(`Responses function_call_arguments.done arguments differ from item ${label}`);
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A stated output_index: absent or null is none, anything else a non-negative integer. */
function outputIndex(value: unknown, event: string, fail: (message: string) => ProviderError): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw fail(`Responses ${event} output_index must be a non-negative integer`);
  }
  return value;
}

/**
 * On a completed turn every item the stream announced (output_item.added) has finished
 * (output_item.done), matched by its stated output_index, else by its id; a finished item at
 * the same index carries the same id. A finished item is then reconciled with the terminal
 * output, so an announced item can be neither lost nor dropped from a supplied output. Only an
 * announced item with neither an index nor an id cannot be checked. An incomplete turn may stop
 * with items unfinished.
 */
function assertAnnouncedItemsFinished(
  announced: AnnouncedEntry[],
  done: DoneEntry[],
  fail: (message: string) => ProviderError,
): void {
  for (const entry of announced) {
    const label = entry.id ?? (entry.index !== undefined ? `at output_index ${entry.index}` : "");
    let finished: DoneEntry | undefined;
    if (entry.index !== undefined) finished = done.find((candidate) => candidate.index === entry.index);
    if (!finished && entry.id !== undefined) finished = done.find((candidate) => candidate.item.id === entry.id);
    if (!finished) {
      if (entry.index === undefined && entry.id === undefined) continue;
      throw fail(`Responses completed stream never finished the announced ${entry.type} item ${label}`);
    }
    const finishedId = typeof finished.item.id === "string" ? finished.item.id : undefined;
    if (finished.item.type !== entry.type || (entry.id !== undefined && finishedId !== undefined && finishedId !== entry.id)) {
      throw fail(`Responses stream finished a different item than the announced ${entry.type} item ${label}`);
    }
  }
}

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
 * Map Responses API stream events to LangFn stream events: text deltas to `content` and
 * reasoning summary and reasoning text deltas to `reasoning` as they arrive; then, from the
 * terminal response, `tool_call` for each finished function call, `token_usage`, the
 * replayable assistant `message` and `end`. Tool calls wait for the terminal event because a
 * call is only executable once the response completes: an incomplete response (for example
 * `max_output_tokens`) yields no tool calls and ends with `length`. A stream that ends without
 * a terminal event, reports a failure, or whose terminal outcome is ambiguous (an event name
 * that conflicts with the JSON type for any event, a JSON type that is not a non-empty string, any populated
 * error on any frame or its response, incomplete_details beside a completed status, two finished
 * items on one output index) throws a typed error before any tool call or end. So does a terminal response that
 * disagrees with what the stream already reported as finished (see
 * {@link reconcileFinishedItems}), a malformed or different response id, or a returned call
 * reusing a call_id of the sent history (`options.sentCallIds`), a lifecycle frame stating a
 * response status other than queued or in_progress, or a completed turn that never finished an
 * item it announced (see {@link assertAnnouncedItemsFinished}). Terminal answer text not already
 * streamed as deltas is delivered as one `content` event before the tool calls, so a consumer
 * that accumulates `content` sees the whole answer; terminal text that does not extend the
 * streamed text fails. A reported error decides the
 * typed class before any other check. An empty SSE event name or `message` is the default event
 * type and defers to the JSON type. Once the
 * terminal response is validated, the events are released (the body is no longer read) before
 * its `tool_call`, `token_usage`, `message` and `end` events are yielded.
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
  const announced: AnnouncedEntry[] = [];
  const announcedIndexes = new Set<number>();
  // The text already delivered as content deltas; the terminal text must extend it.
  let streamedText = "";
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
    // whatever event they name, or the frame is ambiguous (a finished item could be hidden from
    // the ledger, a lifecycle id from its check).
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
    const type = jsonType ?? eventName;

    switch (type) {
      case "response.output_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses text delta must be a string");
        if (payload.delta) {
          streamedText += payload.delta;
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
      case "response.created":
      case "response.queued":
      case "response.in_progress": {
        // A lifecycle frame that states a response status states a running one: any other
        // (failed, completed, incomplete, unknown) contradicts the success path that follows.
        const lifecycleStatus = isRecord(payload.response) ? payload.response.status : undefined;
        if (lifecycleStatus !== undefined && lifecycleStatus !== null && lifecycleStatus !== "queued" && lifecycleStatus !== "in_progress") {
          // A populated error was raised above; a failure that names none is still a failure.
          if (lifecycleStatus === "failed") throw responsesError(provider, { body: payload, error: {} });
          throw fail(`Responses ${type} event reports response status ${describeWireValue(lifecycleStatus)}`);
        }
        const id = isRecord(payload.response) ? responseId(payload.response, provider) : undefined;
        if (id !== undefined) {
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
      case "response.output_item.added": {
        const item = payload.item;
        if (!isRecord(item)) throw fail("Responses output_item.added requires an item");
        const identity = outputItemIdentity(item, provider);
        const index = outputIndex(payload.output_index, "output_item.added", fail);
        if (index !== undefined) {
          if (announcedIndexes.has(index)) throw fail(`Responses output_item.added repeats output_index ${index}`);
          announcedIndexes.add(index);
        }
        announced.push({
          type: identity.type,
          ...(identity.id !== undefined ? { id: identity.id } : {}),
          ...(index !== undefined ? { index } : {}),
        });
        break;
      }
      case "response.output_item.done": {
        const item = payload.item;
        if (!isRecord(item)) throw fail("Responses output_item.done requires an item");
        const index = outputIndex(payload.output_index, "output_item.done", fail);
        if (index === undefined) {
          done.push({ item });
          break;
        }
        // A repeated index would silently replace a finished item, and with it maybe a call.
        if (statedIndexes.has(index)) throw fail(`Responses output_item.done repeats output_index ${index}`);
        statedIndexes.add(index);
        done.push({ item, index });
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        // A reported error on the event or its response was judged above.
        const response = payload.response;
        if (!isRecord(response)) throw fail(`Responses ${type} event requires a response`);
        // Some compatible servers omit the output (or send it empty) in the terminal event;
        // only then is it rebuilt from the finished items. Any other non-array output,
        // including null, is malformed and fails in parseResponsesResponse, as it does for a
        // JSON response.
        const omitted = response.output === undefined
          || (Array.isArray(response.output) && response.output.length === 0);
        const output = omitted ? rebuildOutput(done) : response.output;
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
        if (status !== "failed") {
          reconcileFinishedItems({ done, argumentsDone, output, omitted, completed: status === "completed", fail, provider });
          if (status === "completed") assertAnnouncedItemsFinished(announced, done, fail);
        }
        const result = parseResponsesResponse({ ...response, status, output }, provider, options);
        // The answer text reaches the caller as content events whatever the server streamed:
        // the terminal text not already delivered as deltas is delivered now, once. Terminal
        // text that does not extend the streamed text is a contradiction.
        if (!result.message.content.startsWith(streamedText)) {
          throw fail(`Responses ${type} event text differs from the streamed text`);
        }
        terminal = [];
        const undelivered = result.message.content.slice(streamedText.length);
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
        // Lifecycle and *.done events carry no new data for LangFn stream events.
        break;
    }
  }
  if (!terminal) throw fail("Responses stream ended before a terminal response event");
  // Leaving the frame loop has already released the body (which cancels the read and clears a
  // transport deadline), so the fully received turn is delivered whatever the body would do next.
  yield* terminal;
}
