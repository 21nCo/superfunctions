import { ProviderError } from "../../core/errors.js";
import { describeWireValue, outputItemIdentities, outputItemIdentity, parseFunctionCall, parseOutputItems } from "./response.js";

type JsonRecord = Record<string, unknown>;
type Fail = (message: string) => ProviderError;

/** What one stream event states about the output item it names. */
export interface ItemFacts {
  type?: string;
  id?: string;
  callId?: string;
  /** A function call's name, when non-empty. */
  name?: string;
  index?: number;
}

const FACT_KEYS = ["type", "id", "callId", "name", "index"] as const;

/** Streamed text or arguments, in arrival order (`seq`). */
interface Chunk {
  seq: number;
  contentIndex?: number;
  text: string;
}

/** Streamed text and the text snapshots stated for one item (or for no item). */
interface TextRecord {
  text: Chunk[];
  /** output_text.done and content_part.done text, by content_index. */
  snapshots: Map<number, string>;
  /** Snapshot text that names no content_index: the item's whole text. */
  whole?: string;
}

interface Entry extends ItemFacts, TextRecord {
  /** Arrival order of the first event naming the item. */
  seq: number;
  announced?: JsonRecord;
  finished?: JsonRecord;
  terminal?: JsonRecord;
  args: Chunk[];
  argsDone?: string;
}

/** Item types whose call_id and name identify a call. */
const CALL_TYPES = new Set(["function_call", "custom_tool_call"]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasLocator(facts: ItemFacts): boolean {
  return facts.index !== undefined || facts.id !== undefined || facts.callId !== undefined;
}

function holdsText(record: TextRecord): boolean {
  return record.text.length > 0 || record.snapshots.size > 0 || record.whole !== undefined;
}

/**
 * Validate an item a running stream states before it finishes (an announcement or an item of a
 * running response's output) by the rules of an incomplete output, since it may be cut short. A
 * message announced before its content is filled may omit the content.
 */
export function validateRunningItems(items: unknown[], provider: string, what: string): void {
  const filled = items.map((item) => (isRecord(item) && item.type === "message" && item.content === undefined ? { ...item, content: [] } : item));
  outputItemIdentities(filled, provider, what);
  parseOutputItems(filled, provider, { incomplete: true });
}

function joined(chunks: Chunk[]): string {
  return [...chunks].sort((left, right) => left.seq - right.seq).map((chunk) => chunk.text).join("");
}

/** The facts an output item states: its validated identity, a function call's name, and the stated index. */
export function itemFacts(item: JsonRecord, provider: string, index?: number): ItemFacts {
  const identity = outputItemIdentity(item, provider);
  const facts: ItemFacts = { type: identity.type };
  if (identity.id !== undefined) facts.id = identity.id;
  // Any item that states a call_id (a function call, a custom tool call, a built-in tool call)
  // is located and reconciled by it; a call's name identifies it too.
  if (identity.callId !== undefined) facts.callId = identity.callId;
  if (CALL_TYPES.has(identity.type) && typeof item.name === "string" && item.name) facts.name = item.name;
  if (index !== undefined) facts.index = index;
  return facts;
}

export interface ResolvedOutput {
  /** The terminal output: the supplied one, or the one rebuilt from the ledger when it was omitted. */
  output: JsonRecord[];
  /** Answer text not already delivered as text deltas, in answer order. */
  undelivered: string;
}

/**
 * One ledger of the output items a Responses stream reports. Every event that names an item
 * (output_item.added, text, refusal, reasoning, content part and function call argument
 * events, empty deltas included, output_item.done, and the terminal output) merges into one
 * entry under one conflict rule:
 * the entry is found by the stated output_index, else id, else call_id; a stated type, id,
 * call_id, function name or output_index that differs from a value already stated for that
 * entry is a ProviderError, and a missing one is filled and never lost. When one event names
 * two entries (say, an index one event used and an id another used), they are the same item and
 * merge under the same rule. So no id or call_id ever belongs to two items, and the terminal
 * output, tool calls and undelivered text all derive from the same entries.
 */
export class OutputLedger {
  private readonly entries: Entry[] = [];
  /** Text deltas and snapshots that name no item: they cover the whole answer. */
  private readonly unlocated: TextRecord = { text: [], snapshots: new Map() };
  /** Entries whose final item was rebuilt from their streamed text. */
  private readonly synthesized = new Set<Entry>();
  /** Every text delta already yielded as content, in arrival order. */
  private streamed = "";
  private seq = 0;

  constructor(private readonly fail: Fail, private readonly provider: string) {}

  /** output_item.added */
  announce(item: JsonRecord, index: number | undefined): void {
    validateRunningItems([item], this.provider, "output_item.added");
    const facts = itemFacts(item, this.provider, index);
    const entry = hasLocator(facts) ? this.locate(facts, "output_item.added") : this.create(facts);
    if (entry.announced) throw this.fail(`Responses output_item.added announces ${this.describe(entry)} twice`);
    entry.announced = item;
  }

  /** output_item.done */
  finish(item: JsonRecord, index: number | undefined): void {
    const facts = itemFacts(item, this.provider, index);
    // An item that matches no entry may finish the oldest announcement that stated no index or
    // identity, when the types agree, so such an announcement still resolves one to one.
    const pending = this.named(facts).length ? undefined : this.entries.find((candidate) =>
      candidate.announced && !candidate.finished && !hasLocator(candidate) && candidate.type === facts.type);
    let entry: Entry;
    if (pending) {
      this.state(pending, facts, "output_item.done");
      entry = pending;
    } else entry = hasLocator(facts) ? this.locate(facts, "output_item.done") : this.create(facts);
    if (entry.finished) throw this.fail(`Responses output_item.done finishes ${this.describe(entry)} twice`);
    entry.finished = item;
  }

  /**
   * Any other event that names an item (a reasoning, refusal or content part event, a text
   * done event, a built-in tool event): its locator and implied type, if any, merge into the
   * entry like any other fact. An event that names no item states nothing.
   */
  note(type: string | undefined, itemId: string | undefined, index: number | undefined, what: string): void {
    if (itemId === undefined && index === undefined) return;
    this.locate({ ...(type !== undefined ? { type } : {}), ...(itemId !== undefined ? { id: itemId } : {}), ...(index !== undefined ? { index } : {}) }, what);
  }

  /**
   * output_text.delta; one that names no item covers the whole answer. An empty delta still
   * states its item; a non-empty one is content the caller has received.
   */
  text(itemId: string | undefined, index: number | undefined, contentIndex: number | undefined, delta: string): void {
    const chunk: Chunk = { seq: this.seq++, ...(contentIndex !== undefined ? { contentIndex } : {}), text: delta };
    if (itemId === undefined && index === undefined) {
      if (delta) this.unlocated.text.push(chunk);
    } else {
      const entry = this.locate({ type: "message", ...(itemId !== undefined ? { id: itemId } : {}), ...(index !== undefined ? { index } : {}) }, "output_text.delta");
      if (delta) entry.text.push(chunk);
    }
    this.streamed += delta;
  }

  /**
   * output_text.done, or content_part.done with an output_text part: the whole text of that
   * part (of the whole item when no content_index is named). The final item must hold exactly
   * this text there, and when the output is omitted it fills the part.
   */
  textDone(itemId: string | undefined, index: number | undefined, contentIndex: number | undefined, text: string, what: string): void {
    const record: TextRecord = itemId === undefined && index === undefined
      ? this.unlocated
      : this.locate({ type: "message", ...(itemId !== undefined ? { id: itemId } : {}), ...(index !== undefined ? { index } : {}) }, what);
    const known = contentIndex === undefined ? record.whole : record.snapshots.get(contentIndex);
    if (known !== undefined && known !== text) throw this.fail(`Responses ${what} states different text for one text part`);
    if (contentIndex === undefined) record.whole = text;
    else record.snapshots.set(contentIndex, text);
  }

  /** function_call_arguments.delta; an empty delta still states its item. */
  argumentsDelta(itemId: string | undefined, index: number | undefined, delta: string): void {
    const entry = this.callEntry(itemId, index, "function_call_arguments.delta");
    if (delta) entry.args.push({ seq: this.seq++, text: delta });
  }

  /** function_call_arguments.done */
  argumentsDone(itemId: string | undefined, index: number | undefined, args: string): void {
    const entry = this.callEntry(itemId, index, "function_call_arguments.done");
    if (entry.argsDone !== undefined) throw this.fail(`Responses function_call_arguments.done repeats for ${this.describe(entry)}`);
    entry.argsDone = args;
  }

  /**
   * Reconcile the ledger with the terminal response, before any tool call, message or end:
   * - A supplied output is validated like a JSON one and merges into the ledger item by item at
   *   its positions. Every finished item that names an index or identity must be in it, as the
   *   same item: a function call keeps its name and arguments, and an item that held streamed
   *   text is there too. An omitted output (absent or `[]`) is rebuilt from the finished items
   *   (see {@link rebuild}). Each final item carries the id and call_id the ledger holds for it.
   * - On a completed turn every announced item has finished, and every finished call is
   *   executable. An incomplete turn may stop with items unfinished.
   * - Each function_call_arguments.done repeats the arguments of the call it names; on a
   *   completed turn the streamed argument deltas add up to them too.
   * - One delivery rule for every turn: the content already yielded, in arrival order, must be
   *   a prefix of the final answer (the output_text parts of the final output, in output then
   *   content order, which is the message content), and exactly the rest is delivered.
   *   Anything else is a ProviderError, since content already yielded cannot be recalled.
   */
  resolve(state: { output: unknown; omitted: boolean; completed: boolean; type: string }): ResolvedOutput {
    const { omitted, completed, type } = state;
    const finished = this.entries.filter((entry) => entry.finished);
    // Shape and identity rules of a JSON output apply to every finished item.
    outputItemIdentities(finished.map((entry) => entry.finished), this.provider, "output_item.done");
    if (completed) {
      for (const entry of finished) {
        const item = entry.finished as JsonRecord;
        if (entry.type !== "function_call") continue;
        if (!(item.status === undefined || item.status === null || item.status === "completed")) {
          throw this.fail("Responses completed stream finished an unfinished function_call");
        }
        parseFunctionCall(this.withIdentity(entry, item), this.provider);
      }
    }
    parseOutputItems(finished.map((entry) => this.withIdentity(entry, entry.finished as JsonRecord)), this.provider, { incomplete: !completed });

    let output: JsonRecord[];
    // The final item of each entry: the supplied terminal item, or the finished (or rebuilt) one.
    const final = new Map<Entry, JsonRecord>();
    if (!omitted) {
      // A malformed output fails in parseResponsesResponse, as it does for a JSON response.
      if (!Array.isArray(state.output)) return { output: state.output as JsonRecord[], undelivered: "" };
      outputItemIdentities(state.output, this.provider, "terminal output");
      output = (state.output as JsonRecord[]).map((supplied, position) => {
        const entry = this.locate(itemFacts(supplied, this.provider, position), "terminal output");
        const item = this.withIdentity(entry, supplied);
        entry.terminal = item;
        final.set(entry, item);
        if (entry.finished && CALL_TYPES.has(entry.type as string)
          && (entry.finished.name !== item.name || entry.finished.arguments !== item.arguments || entry.finished.input !== item.input)) {
          throw this.fail(`Responses terminal output changed the finished ${this.describe(entry)}`);
        }
        return item;
      });
      for (const entry of this.entries) {
        if (entry.finished && !entry.terminal && hasLocator(entry)) {
          throw this.fail(`Responses terminal output does not have the finished ${this.describe(entry)}`);
        }
        if (holdsText(entry) && !entry.terminal) {
          throw this.fail(`Responses terminal output does not have the streamed ${this.describe(entry)}`);
        }
      }
    } else {
      output = this.rebuild(completed, final, type);
    }

    for (const entry of this.entries) {
      if (completed && entry.announced && !entry.finished) {
        throw this.fail(`Responses completed stream never finished the announced ${this.describe(entry)}`);
      }
      const item = final.get(entry);
      // Every snapshot and located text the stream stated for the item agrees with its final form.
      if (item && holdsText(entry)) this.assertText(entry, item, type);
      const call = item?.type === "function_call" ? item : undefined;
      // Streamed argument deltas are only judged on a completed turn; a truncated call never runs.
      const streamedArgs = completed && entry.args.length ? joined(entry.args) : undefined;
      if (entry.argsDone !== undefined || streamedArgs !== undefined) {
        if (!call) throw this.fail(`Responses function_call arguments name an unknown ${this.describe(entry)}`);
        if (entry.argsDone !== undefined && call.arguments !== entry.argsDone) {
          throw this.fail(`Responses function_call_arguments.done arguments differ from ${this.describe(entry)}`);
        }
        if (streamedArgs !== undefined && call.arguments !== streamedArgs) {
          throw this.fail(`Responses streamed function_call arguments differ from ${this.describe(entry)}`);
        }
      }
      // On a completed turn, every item any event named (an announcement, a delta, empty or not,
      // a done event, a reasoning or content part event) is in the final output.
      if (completed && !item && hasLocator(entry)) {
        throw this.fail(`Responses completed stream never resolved the ${this.describe(entry)} its events named`);
      }
    }

    return { output, undelivered: this.undelivered(output, type) };
  }

  /** The final item with the id, and a function call's call_id, that the ledger holds for it. */
  private withIdentity(entry: Entry, item: JsonRecord): JsonRecord {
    const missing = (value: unknown) => value === undefined || value === null;
    const id = entry.id !== undefined && missing(item.id) ? { id: entry.id } : {};
    const callId = entry.callId !== undefined && missing(item.call_id) ? { call_id: entry.callId } : {};
    return Object.keys(id).length || Object.keys(callId).length ? { ...item, ...id, ...callId } : item;
  }

  private callEntry(itemId: string | undefined, index: number | undefined, what: string): Entry {
    if (itemId === undefined && index === undefined) throw this.fail(`Responses ${what} names no item`);
    return this.locate({ type: "function_call", ...(itemId !== undefined ? { id: itemId } : {}), ...(index !== undefined ? { index } : {}) }, what);
  }

  private create(facts: ItemFacts, seq = this.seq++): Entry {
    const entry: Entry = { seq, text: [], snapshots: new Map(), args: [] };
    this.state(entry, facts, "");
    this.entries.push(entry);
    return entry;
  }

  /** The entries an event's index, id and call_id name, oldest first. */
  private named(facts: ItemFacts): Entry[] {
    const named = new Set<Entry>();
    for (const key of ["index", "id", "callId"] as const) {
      if (facts[key] === undefined) continue;
      const entry = this.entries.find((candidate) => candidate[key] === facts[key]);
      if (entry) named.add(entry);
    }
    return [...named].sort((left, right) => left.seq - right.seq);
  }

  /** The one entry an event names, merging entries it shows to be one item; its facts are stated on it. */
  private locate(facts: ItemFacts, what: string): Entry {
    const [entry, ...others] = this.named(facts);
    if (!entry) return this.create(facts);
    for (const other of others) this.absorb(entry, other, what);
    this.state(entry, facts, what);
    return entry;
  }

  /** State facts on an entry: a stated value never changes, and a missing one is filled. */
  private state(entry: Entry, facts: ItemFacts, what: string): void {
    for (const key of FACT_KEYS) {
      const value = facts[key];
      if (value === undefined) continue;
      const known = entry[key];
      if (known !== undefined && known !== value) {
        const field = key === "callId" ? "call_id" : key === "index" ? "output_index" : key;
        throw this.fail(`Responses ${what} states ${field} ${describeWireValue(value)} for ${this.describe(entry)}`);
      }
      (entry as unknown as Record<string, unknown>)[key] = value;
    }
  }

  /** Merge two entries that one event shows to be the same item. */
  private absorb(entry: Entry, other: Entry, what: string): void {
    this.state(entry, other, what);
    entry.seq = Math.min(entry.seq, other.seq);
    for (const key of ["announced", "finished", "terminal", "argsDone"] as const) {
      if (other[key] === undefined) continue;
      if (entry[key] !== undefined) throw this.fail(`Responses ${what} names two different items as ${this.describe(entry)}`);
      (entry as unknown as Record<string, unknown>)[key] = other[key];
    }
    entry.text.push(...other.text);
    entry.args.push(...other.args);
    for (const [contentIndex, snapshot] of other.snapshots) {
      const known = entry.snapshots.get(contentIndex);
      if (known !== undefined && known !== snapshot) throw this.fail(`Responses ${what} states different text for one text part`);
      entry.snapshots.set(contentIndex, snapshot);
    }
    if (other.whole !== undefined) {
      if (entry.whole !== undefined && entry.whole !== other.whole) throw this.fail(`Responses ${what} states different text for one text part`);
      entry.whole = other.whole;
    }
    this.entries.splice(this.entries.indexOf(other), 1);
  }

  /**
   * The output an omitted one stands for: the finished items, and streamed text that no finished
   * item holds as an assistant message of that text, so message content and the replayed turn
   * keep what the caller already received. Items are ordered by their stated output_index, or
   * by arrival when none states one; a mix is ambiguous and a ProviderError. Text that names no
   * item, when no item holds text, becomes a message after them.
   */
  private rebuild(completed: boolean, final: Map<Entry, JsonRecord>, type: string): JsonRecord[] {
    const status = completed ? "completed" : "incomplete";
    const message = (entry: TextRecord & { announced?: JsonRecord; id?: string }): JsonRecord => {
      const base = entry.announced?.type === "message" ? structuredClone(entry.announced) : {};
      return {
        ...base,
        type: "message",
        ...(entry.id !== undefined ? { id: entry.id } : {}),
        role: "assistant",
        status,
        content: this.parts(entry, type).map((text) => ({ type: "output_text", text, annotations: [] })),
      };
    };
    const items: Array<{ entry: Entry; item: JsonRecord }> = [];
    // A message built from streamed text is consistent with it by construction (parts).
    this.synthesized.clear();
    for (const entry of this.entries) {
      if (entry.finished) items.push({ entry, item: this.withIdentity(entry, entry.finished) });
      else if (holdsText(entry)) {
        const item = message(entry);
        this.synthesized.add(entry);
        items.push({ entry, item });
      }
    }
    const indexed = items.filter(({ entry }) => entry.index !== undefined).length;
    if (indexed && indexed !== items.length) {
      throw this.fail("Responses stream omitted its output, and its items state an output_index only in part");
    }
    const ordered = [...items].sort((left, right) => (indexed
      ? (left.entry.index as number) - (right.entry.index as number)
      : left.entry.seq - right.entry.seq));
    for (const { entry, item } of ordered) final.set(entry, item);
    const output = ordered.map(({ item }) => item);
    const hasAnswer = output.some((item) => item.type === "message" && Array.isArray(item.content)
      && item.content.some((part) => isRecord(part) && part.type === "output_text"));
    if (holdsText(this.unlocated) && !hasAnswer) output.push(message(this.unlocated));
    return output;
  }

  /**
   * The text parts of a message rebuilt from what the stream stated, in content order: each
   * named part holds its snapshot, else its streamed text, and a snapshot must extend the text
   * streamed to its part. Text that names no part is one part. Naming a part in some events and
   * not in others is ambiguous and a ProviderError.
   */
  private parts(record: TextRecord, type: string): string[] {
    const loose = record.text.filter((chunk) => chunk.contentIndex === undefined);
    const located = record.text.filter((chunk) => chunk.contentIndex !== undefined);
    const named = located.length > 0 || record.snapshots.size > 0;
    if (named && (loose.length || record.whole !== undefined)) {
      throw this.fail("Responses stream text events name one text part in two ways");
    }
    const part = (streamed: string, snapshot: string | undefined) => {
      if (snapshot !== undefined && !snapshot.startsWith(streamed)) {
        throw this.fail(`Responses ${type} event: a text done event differs from the streamed text`);
      }
      return snapshot ?? streamed;
    };
    if (!named) return [part(joined(loose), record.whole)];
    const indexes = [...new Set([...located.map((chunk) => chunk.contentIndex as number), ...record.snapshots.keys()])]
      .sort((left, right) => left - right);
    return indexes.map((contentIndex) => part(
      joined(located.filter((chunk) => chunk.contentIndex === contentIndex)),
      record.snapshots.get(contentIndex),
    ));
  }

  /**
   * The text the stream stated for an item agrees with its final form: the text streamed to the
   * item, in arrival order, is a prefix of the item's whole text (its output_text parts in
   * content order), and a snapshot is exactly the text of the part it names (of the whole item
   * when it names none). The order of the parts is judged by the delivery rule (undelivered). A message rebuilt from the stream agrees by
   * construction, whatever positions its parts take.
   */
  private assertText(entry: Entry, item: JsonRecord, type: string): void {
    if (this.synthesized.has(entry)) return;
    const content = Array.isArray(item.content) ? item.content : [];
    const textAt = (contentIndex: number): string | undefined => {
      const part: unknown = content[contentIndex];
      return isRecord(part) && part.type === "output_text" && typeof part.text === "string" ? part.text : undefined;
    };
    const whole = content.map((_, contentIndex) => textAt(contentIndex) ?? "").join("");
    const fail = () => this.fail(`Responses ${type} event text of ${this.describe(entry)} differs from the text the stream stated for it`);
    if (!whole.startsWith(joined(entry.text))) throw fail();
    for (const [contentIndex, snapshot] of entry.snapshots) if (textAt(contentIndex) !== snapshot) throw fail();
    if (entry.whole !== undefined && whole !== entry.whole) throw fail();
  }

  /** The answer text not yet delivered: the content yielded so far must be a prefix of the answer. */
  private undelivered(output: JsonRecord[], type: string): string {
    const answer: string[] = [];
    for (const item of output) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") answer.push(part.text);
      }
    }
    const text = answer.join("");
    if (!text.startsWith(this.streamed)) {
      throw this.fail(`Responses ${type} event answer text differs from the streamed text`);
    }
    return text.slice(this.streamed.length);
  }

  private describe(entry: ItemFacts): string {
    const label = entry.callId ?? entry.id ?? (entry.index !== undefined ? `at output_index ${entry.index}` : undefined);
    return `${entry.type ?? "output"} item${label !== undefined ? ` ${label}` : ""}`;
  }
}
