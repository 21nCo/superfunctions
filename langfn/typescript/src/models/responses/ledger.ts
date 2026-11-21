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

interface Entry extends ItemFacts {
  /** Arrival order of the first event naming the item. */
  seq: number;
  announced?: JsonRecord;
  finished?: JsonRecord;
  terminal?: JsonRecord;
  text: Chunk[];
  args: Chunk[];
  argsDone?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasLocator(facts: ItemFacts): boolean {
  return facts.index !== undefined || facts.id !== undefined || facts.callId !== undefined;
}

function joined(chunks: Chunk[]): string {
  return [...chunks].sort((left, right) => left.seq - right.seq).map((chunk) => chunk.text).join("");
}

/** The facts an output item states: its validated identity, a function call's name, and the stated index. */
export function itemFacts(item: JsonRecord, provider: string, index?: number): ItemFacts {
  const identity = outputItemIdentity(item, provider);
  const facts: ItemFacts = { type: identity.type };
  if (identity.id !== undefined) facts.id = identity.id;
  if (identity.type === "function_call") {
    if (identity.callId !== undefined) facts.callId = identity.callId;
    if (typeof item.name === "string" && item.name) facts.name = item.name;
  }
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
 * (output_item.added, output_text.delta, function_call_arguments.delta and .done,
 * output_item.done, and the terminal output) merges into one entry under one conflict rule:
 * the entry is found by the stated output_index, else id, else call_id; a stated type, id,
 * call_id, function name or output_index that differs from a value already stated for that
 * entry is a ProviderError, and a missing one is filled and never lost. When one event names
 * two entries (say, an index one event used and an id another used), they are the same item and
 * merge under the same rule. So no id or call_id ever belongs to two items, and the terminal
 * output, tool calls and undelivered text all derive from the same entries.
 */
export class OutputLedger {
  private readonly entries: Entry[] = [];
  /** Text deltas that name no item: they cover the whole answer. */
  private readonly unlocated: Chunk[] = [];
  private seq = 0;
  /** Whether an omitted output was rebuilt with streamed text no finished item held. */
  private synthesized = false;

  constructor(private readonly fail: Fail, private readonly provider: string) {}

  /** output_item.added */
  announce(item: JsonRecord, index: number | undefined): void {
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

  /** output_text.delta; one that names no item covers the whole answer. */
  text(itemId: string | undefined, index: number | undefined, contentIndex: number | undefined, delta: string): void {
    const chunk: Chunk = { seq: this.seq++, ...(contentIndex !== undefined ? { contentIndex } : {}), text: delta };
    if (itemId === undefined && index === undefined) {
      this.unlocated.push(chunk);
      return;
    }
    this.locate({ type: "message", ...(itemId !== undefined ? { id: itemId } : {}), ...(index !== undefined ? { index } : {}) }, "output_text.delta")
      .text.push(chunk);
  }

  /** function_call_arguments.delta */
  argumentsDelta(itemId: string | undefined, index: number | undefined, delta: string): void {
    this.callEntry(itemId, index, "function_call_arguments.delta").args.push({ seq: this.seq++, text: delta });
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
   *   same item: a function call keeps its name and arguments. An omitted output (absent or
   *   `[]`) is rebuilt from the finished items, in stated output_index order when every item
   *   states one, otherwise in arrival order.
   * - On a completed turn every announced item has finished, and every finished call is
   *   executable. An incomplete turn may stop with items unfinished.
   * - Each function_call_arguments.done repeats the arguments of the call it names; on a
   *   completed turn the streamed argument deltas add up to them too.
   * - Streamed text belongs to the part its delta named (content_index; a delta without one
   *   covers all the item's text, and one that names no item the whole answer). It must be a
   *   prefix of that part's text; the rest of each part, and every part never streamed, is
   *   delivered once, in answer order. Streamed text with no terminal counterpart is a
   *   contradiction on a completed turn, and whenever the terminal still has text to deliver
   *   (it could be the same text twice). Otherwise a truncated turn keeps it, and an omitted
   *   output keeps text that no finished item holds as a message, so the replayed turn has it.
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
        parseFunctionCall(item, this.provider);
      }
    }
    parseOutputItems(finished.map((entry) => entry.finished), this.provider, { incomplete: !completed });

    let output: JsonRecord[];
    // The final item of each entry: the supplied terminal item, or the finished (or rebuilt) one.
    const final = new Map<Entry, JsonRecord>();
    if (!omitted) {
      // A malformed output fails in parseResponsesResponse, as it does for a JSON response.
      if (!Array.isArray(state.output)) return { output: state.output as JsonRecord[], undelivered: "" };
      output = state.output as JsonRecord[];
      outputItemIdentities(output, this.provider, "terminal output");
      output.forEach((item, position) => {
        const entry = this.locate(itemFacts(item, this.provider, position), "terminal output");
        entry.terminal = item;
        final.set(entry, item);
        if (entry.finished && entry.type === "function_call"
          && (entry.finished.name !== item.name || entry.finished.arguments !== item.arguments)) {
          throw this.fail(`Responses terminal output changed the finished ${this.describe(entry)}`);
        }
      });
      for (const entry of this.entries) {
        if (entry.finished && !entry.terminal && hasLocator(entry)) {
          throw this.fail(`Responses terminal output does not have the finished ${this.describe(entry)}`);
        }
      }
    } else {
      output = this.rebuild(completed, final);
    }

    for (const entry of this.entries) {
      if (completed && entry.announced && !entry.finished) {
        throw this.fail(`Responses completed stream never finished the announced ${this.describe(entry)}`);
      }
      const item = final.get(entry);
      const call = item?.type === "function_call" ? item : undefined;
      // Streamed argument deltas are only judged on a completed turn; a truncated call never runs.
      const streamedArgs = completed && entry.args.length ? joined(entry.args) : undefined;
      if (entry.argsDone === undefined && streamedArgs === undefined) continue;
      if (!call) throw this.fail(`Responses function_call arguments name an unknown ${this.describe(entry)}`);
      if (entry.argsDone !== undefined && call.arguments !== entry.argsDone) {
        throw this.fail(`Responses function_call_arguments.done arguments differ from ${this.describe(entry)}`);
      }
      if (streamedArgs !== undefined && call.arguments !== streamedArgs) {
        throw this.fail(`Responses streamed function_call arguments differ from ${this.describe(entry)}`);
      }
    }

    return { output, undelivered: this.undelivered(output, final, completed, type) };
  }

  private callEntry(itemId: string | undefined, index: number | undefined, what: string): Entry {
    if (itemId === undefined && index === undefined) throw this.fail(`Responses ${what} names no item`);
    return this.locate({ type: "function_call", ...(itemId !== undefined ? { id: itemId } : {}), ...(index !== undefined ? { index } : {}) }, what);
  }

  private create(facts: ItemFacts, seq = this.seq++): Entry {
    const entry: Entry = { seq, text: [], args: [] };
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
    this.entries.splice(this.entries.indexOf(other), 1);
  }

  private rebuildOrder<T extends { seq: number; index?: number }>(entries: T[]): T[] {
    const stated = entries.every((entry) => entry.index !== undefined);
    return [...entries].sort((left, right) => (stated ? (left.index as number) - (right.index as number) : left.seq - right.seq));
  }

  /**
   * The output an omitted one stands for: the finished items, and streamed text that no finished
   * item holds as an assistant message of that text, so message content and the replayed turn
   * keep what the caller already received.
   */
  private rebuild(completed: boolean, final: Map<Entry, JsonRecord>): JsonRecord[] {
    const status = completed ? "completed" : "incomplete";
    const message = (entry: { announced?: JsonRecord; id?: string }, chunks: Chunk[]): JsonRecord => {
      const base = entry.announced?.type === "message" ? structuredClone(entry.announced) : {};
      return {
        ...base,
        type: "message",
        ...(entry.id !== undefined ? { id: entry.id } : {}),
        role: "assistant",
        status,
        content: this.parts(chunks).map(({ text }) => ({ type: "output_text", text, annotations: [] })),
      };
    };
    const items: Array<{ seq: number; index?: number; item: JsonRecord; entry?: Entry }> = [];
    for (const entry of this.entries) {
      if (entry.finished) items.push({ seq: entry.seq, ...(entry.index !== undefined ? { index: entry.index } : {}), item: entry.finished, entry });
      else if (entry.text.length) {
        this.synthesized = true;
        items.push({ seq: entry.seq, ...(entry.index !== undefined ? { index: entry.index } : {}), item: message(entry, entry.text), entry });
      }
    }
    const holdsText = items.some(({ item }) => item.type === "message" && Array.isArray(item.content)
      && item.content.some((part) => isRecord(part) && part.type === "output_text"));
    if (this.unlocated.length && !holdsText) {
      this.synthesized = true;
      items.push({ seq: this.unlocated[0].seq, item: message({}, this.unlocated.map(({ seq, text }) => ({ seq, text }))) });
    }
    const ordered = this.rebuildOrder(items);
    for (const { entry, item } of ordered) if (entry) final.set(entry, item);
    return ordered.map(({ item }) => item);
  }

  /** Streamed text grouped by the content part it names, in content order; one group when none is named. */
  private parts(chunks: Chunk[]): Array<{ contentIndex?: number; text: string }> {
    const located = chunks.filter((chunk) => chunk.contentIndex !== undefined);
    if (located.length && located.length !== chunks.length) {
      throw this.fail("Responses stream text deltas name one text part in two ways");
    }
    if (!located.length) return [{ text: joined(chunks) }];
    const indexes = [...new Set(located.map((chunk) => chunk.contentIndex as number))].sort((left, right) => left - right);
    return indexes.map((contentIndex) => ({ contentIndex, text: joined(located.filter((chunk) => chunk.contentIndex === contentIndex)) }));
  }

  private undelivered(
    output: JsonRecord[],
    final: Map<Entry, JsonRecord>,
    completed: boolean,
    type: string,
  ): string {
    // Every output_text part of the answer, in answer order.
    const parts: Array<{ item: JsonRecord; contentIndex: number; text: string; delivered: number; claimed?: boolean }> = [];
    for (const item of output) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      item.content.forEach((part: unknown, contentIndex: number) => {
        if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
          parts.push({ item, contentIndex, text: part.text, delivered: 0 });
        }
      });
    }
    let unplaced = false;
    const claim = (claimed: typeof parts, text: string): void => {
      if (!claimed.length) {
        unplaced = true;
        return;
      }
      if (claimed.some((part) => part.claimed)) throw this.fail("Responses stream text deltas name one text part in two ways");
      if (!claimed.map((part) => part.text).join("").startsWith(text)) {
        throw this.fail(`Responses ${type} event text differs from the streamed text`);
      }
      let remaining = text.length;
      for (const part of claimed) {
        part.claimed = true;
        part.delivered = Math.min(remaining, part.text.length);
        remaining -= part.delivered;
      }
    };
    for (const entry of this.entries) {
      if (!entry.text.length) continue;
      const item = final.get(entry);
      const own = parts.filter((part) => part.item === item);
      for (const group of this.parts(entry.text)) {
        claim(group.contentIndex === undefined ? own : own.filter((part) => part.contentIndex === group.contentIndex), group.text);
      }
    }
    if (this.unlocated.length) claim(parts, joined(this.unlocated));
    const rest = parts.map((part) => part.text.slice(part.delivered)).join("");
    // Text that is not where the terminal has it could be the undelivered text itself.
    if ((unplaced || this.synthesized) && rest) {
      throw this.fail(`Responses ${type} event streamed text that the terminal output does not place`);
    }
    // A completed turn's final items must hold what was streamed to them.
    if (unplaced && completed) {
      throw this.fail(`Responses ${type} event has no text part for the streamed text`);
    }
    return rest;
  }

  private describe(entry: ItemFacts): string {
    const label = entry.callId ?? entry.id ?? (entry.index !== undefined ? `at output_index ${entry.index}` : undefined);
    return `${entry.type ?? "output"} item${label !== undefined ? ` ${label}` : ""}`;
  }
}
