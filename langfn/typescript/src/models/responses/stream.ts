import { LangFnError, ProviderError } from "../../core/errors.js";
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

interface ArgumentsDone {
  itemId?: string;
  index?: number;
  arguments: string;
}

/** An item the stream announced with output_item.added. */
interface AnnouncedEntry {
  type: string;
  id?: string;
  callId?: string;
  /** A function call's name, when the announcement carries a non-empty one. */
  name?: string;
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

/** Text a run of output_text deltas streamed, with the part they named. */
interface StreamedText {
  itemId?: string;
  index?: number;
  contentIndex?: number;
  text: string;
}

/**
 * The terminal answer text not already streamed as deltas, judged per part. Streamed text
 * belongs to the output_text part its delta named: the output item by item_id and/or
 * output_index (both must name the same item), and the part by content_index; a delta without
 * a content_index names all the item's text, and one that names no item names the whole answer.
 * The text streamed to a part (or run of parts) must be a prefix of that part's terminal text,
 * else the terminal text contradicts the stream; the rest of each part, and every part never
 * streamed, is delivered once, in answer order. Text streamed to two overlapping places (for
 * example located and unlocated deltas) cannot be placed. Streamed text with no terminal
 * counterpart is a contradiction only when a completed turn supplies its output; a truncated
 * turn or an omitted output keeps the text already delivered.
 */
function undeliveredText(state: {
  streamed: StreamedText[];
  output: JsonRecord[];
  done: DoneEntry[];
  omitted: boolean;
  completed: boolean;
  type: string;
  fail: (message: string) => ProviderError;
}): string {
  const { streamed, output, done, omitted, completed, type, fail } = state;
  const parts: Array<{ position: number; contentIndex: number; text: string }> = [];
  output.forEach((item, position) => {
    if (item.type !== "message" || !Array.isArray(item.content)) return;
    item.content.forEach((part: unknown, contentIndex: number) => {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        parts.push({ position, contentIndex, text: part.text });
      }
    });
  });
  // The output position a delta names: undefined when it names none, -1 when nothing matches.
  const locate = ({ itemId, index }: StreamedText): number | undefined => {
    let byId: number | undefined;
    let byIndex: number | undefined;
    if (itemId !== undefined) {
      byId = output.findIndex((item) => item.id === itemId);
      if (byId === -1 && !omitted) {
        // A finished item may carry the id its terminal counterpart (matched by index) omits.
        const finished = done.find((entry) => entry.item.id === itemId && entry.index !== undefined);
        if (finished?.index !== undefined && finished.index < output.length) byId = finished.index;
      }
    }
    if (index !== undefined) {
      if (omitted) {
        const finished = done.find((entry) => entry.index === index);
        byIndex = finished ? output.indexOf(finished.item) : -1;
      } else {
        byIndex = index < output.length ? index : -1;
      }
    }
    if (byId === -1 || byIndex === -1) return -1;
    if (byId !== undefined && byIndex !== undefined && byId !== byIndex) {
      throw fail(`Responses stream text delta item ${itemId} is not at output_index ${index}`);
    }
    return byId ?? byIndex;
  };

  // Each streamed run claims a run of parts; runs naming the same parts are one claim.
  const claims = new Map<string, { parts: number[]; text: string }>();
  const owner = new Map<number, string>();
  for (const run of streamed) {
    const position = locate(run);
    let claimed: number[] = [];
    if (position === undefined) claimed = parts.map((_, at) => at);
    else if (position !== -1) {
      parts.forEach((part, at) => {
        if (part.position === position && (run.contentIndex === undefined || part.contentIndex === run.contentIndex)) claimed.push(at);
      });
    }
    if (!claimed.length) {
      if (completed && !omitted) throw fail(`Responses ${type} event has no text part for the streamed text`);
      continue;
    }
    const key = claimed.join(",");
    for (const at of claimed) {
      if (owner.has(at) && owner.get(at) !== key) throw fail("Responses stream text deltas name one text part in two ways");
      owner.set(at, key);
    }
    const claim = claims.get(key);
    if (claim) claim.text += run.text;
    else claims.set(key, { parts: claimed, text: run.text });
  }

  const delivered = new Array<number>(parts.length).fill(0);
  for (const claim of claims.values()) {
    if (!claim.parts.map((at) => parts[at].text).join("").startsWith(claim.text)) {
      throw fail(`Responses ${type} event text differs from the streamed text`);
    }
    let remaining = claim.text.length;
    for (const at of claim.parts) {
      delivered[at] = Math.min(remaining, parts[at].text.length);
      remaining -= delivered[at];
    }
  }
  return parts.map((part, at) => part.text.slice(delivered[at])).join("");
}

/**
 * On a completed turn every item the stream announced (output_item.added) has finished
 * (output_item.done) as the same item, one to one: a finished item answers at most one
 * announcement. An announcement is located by its stated output_index, else by its id, else by
 * its call_id; one that states an index finishes at that index, so the same item (by id or
 * call_id) finished at another index fails. The finished item has the announced type, and the
 * id, call_id and function name agree wherever both carry one. A finished item is then
 * reconciled with the terminal output, so an announced item can be neither lost nor replaced.
 * Only an announcement with no index, id or call_id cannot be checked. An incomplete turn may
 * stop with items unfinished.
 */
function assertAnnouncedItemsFinished(
  announced: AnnouncedEntry[],
  done: DoneEntry[],
  fail: (message: string) => ProviderError,
): void {
  const doneIdentity = done.map(({ item }) => ({
    id: typeof item.id === "string" ? item.id : undefined,
    callId: item.type === "function_call" && typeof item.call_id === "string" ? item.call_id : undefined,
  }));
  const claimed = new Set<number>();
  for (const entry of announced) {
    const label = entry.callId ?? entry.id ?? (entry.index !== undefined ? `at output_index ${entry.index}` : "");
    const sameItem = (at: number) => (entry.id !== undefined && doneIdentity[at].id === entry.id)
      || (entry.callId !== undefined && doneIdentity[at].callId === entry.callId);
    let at = -1;
    if (entry.index !== undefined) {
      at = done.findIndex((candidate) => candidate.index === entry.index);
      const moved = done.some((candidate, position) => candidate.index !== undefined && candidate.index !== entry.index && sameItem(position));
      if (moved) {
        throw fail(`Responses stream finished the announced ${entry.type} item ${label} away from output_index ${entry.index}`);
      }
      // A finished item that states no index is located by its identity.
      if (at === -1) at = done.findIndex((candidate, position) => candidate.index === undefined && sameItem(position));
    } else if (entry.id !== undefined || entry.callId !== undefined) {
      at = done.findIndex((_, position) => sameItem(position));
    } else {
      continue;
    }
    if (at === -1) throw fail(`Responses completed stream never finished the announced ${entry.type} item ${label}`);
    if (claimed.has(at)) throw fail(`Responses stream finished one item for two announced items, including ${entry.type} item ${label}`);
    claimed.add(at);
    const finished = done[at].item;
    const finishedName = typeof finished.name === "string" && finished.name ? finished.name : undefined;
    if (finished.type !== entry.type
      || (entry.id !== undefined && doneIdentity[at].id !== undefined && doneIdentity[at].id !== entry.id)
      || (entry.callId !== undefined && doneIdentity[at].callId !== undefined && doneIdentity[at].callId !== entry.callId)
      || (entry.type === "function_call" && entry.name !== undefined && finishedName !== undefined && finishedName !== entry.name)) {
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
 * response status other than queued or in_progress or reporting incomplete_details, or a
 * completed turn that never finished, one to one, each item it announced (see
 * {@link assertAnnouncedItemsFinished}). Terminal answer text not already streamed as deltas is
 * delivered as one `content` event before the tool calls, so a consumer that accumulates
 * `content` sees the whole answer; terminal text that does not extend the text streamed to its
 * part fails (see {@link undeliveredText}). A reported error decides the
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
  // The text already delivered as content deltas, by the part each delta named.
  const streamed: StreamedText[] = [];
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
        const itemId = payload.item_id;
        if (itemId !== undefined && itemId !== null && (typeof itemId !== "string" || !itemId)) {
          throw fail("Responses output_text.delta item_id must be a non-empty string");
        }
        const index = outputIndex(payload.output_index, "output_text.delta", fail);
        const contentIndex = outputIndex(payload.content_index, "output_text.delta", fail, "content_index");
        if (payload.delta) {
          const last = streamed[streamed.length - 1];
          const located = typeof itemId === "string" ? itemId : undefined;
          if (last && last.itemId === located && last.index === index && last.contentIndex === contentIndex) last.text += payload.delta;
          else {
            streamed.push({
              ...(located !== undefined ? { itemId: located } : {}),
              ...(index !== undefined ? { index } : {}),
              ...(contentIndex !== undefined ? { contentIndex } : {}),
              text: payload.delta,
            });
          }
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
        // A lifecycle envelope is judged by the rule every envelope uses (terminalStatus): a
        // stated status is a running one, and any other (failed, completed, incomplete,
        // unknown, or none beside incomplete_details) contradicts the success path that
        // follows. A running turn has not been truncated, so populated incomplete_details
        // fail too; malformed ones fail in terminalStatus.
        if (isRecord(payload.response)) {
          const lifecycleStatus = terminalStatus(payload.response, provider);
          if (lifecycleStatus !== undefined && lifecycleStatus !== "queued" && lifecycleStatus !== "in_progress") {
            // A populated error was raised above; a failure that names none is still a failure.
            if (lifecycleStatus === "failed") throw responsesError(provider, { body: payload, error: {} });
            throw fail(`Responses ${type} event reports response status ${describeWireValue(lifecycleStatus)}`);
          }
          if (reportsIncompleteDetails(payload.response, provider)) {
            throw fail(`Responses ${type} event reports incomplete_details on a running response`);
          }
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
        const name = identity.type === "function_call" && typeof item.name === "string" && item.name ? item.name : undefined;
        announced.push({
          type: identity.type,
          ...(identity.id !== undefined ? { id: identity.id } : {}),
          ...(identity.type === "function_call" && identity.callId !== undefined ? { callId: identity.callId } : {}),
          ...(name !== undefined ? { name } : {}),
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
        // the terminal text not already delivered as deltas is delivered now, once, judged per
        // text part (see undeliveredText).
        const undelivered = undeliveredText({
          streamed,
          // parseResponsesResponse accepted it: an array of items.
          output: output as JsonRecord[],
          done,
          omitted,
          completed: status === "completed",
          type,
          fail,
        });
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
        // Lifecycle and *.done events carry no new data for LangFn stream events.
        break;
    }
  }
  if (!terminal) throw fail("Responses stream ended before a terminal response event");
  // Leaving the frame loop has already released the body (which cancels the read and clears a
  // transport deadline), so the fully received turn is delivered whatever the body would do next.
  yield* terminal;
}
