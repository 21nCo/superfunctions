import { types } from "node:util";
import type { Diagnostic } from "./diagnostics.js";
import { classifyRunnerFailure, RUNNER_FAILED_CODE, type RunnerErrorPayload } from "./errors.js";
import {
  createDocumentBudget,
  chargeWork,
  createWorkBudget,
  DocumentBudgetExceeded,
  documentLimit,
  encodeString,
  JsonText,
  serializeJsonMember,
  spendText,
  toLength,
  workLeft,
  type DocumentBudget,
  type WorkBudget,
} from "./json-value.js";
import { createOutput, type OutputService, type Spinner } from "./output.js";
import { isDocumentSensitiveKey } from "./sensitive-keys.js";

export interface DocumentOutputOptions {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * The longest text to write to stdout, in characters, counting the document and its newline. Defaults to
   * `documentLimit()`; tests pass a smaller limit. Not part of the public runner options.
   */
  maxLength?: number;
}

export type DocumentOutcome =
  | { ok: true; data: unknown; exitCode: number }
  | { ok: false; error: unknown };

/**
 * The diagnostics of one result document, kept as the document prints them. `add` reads each member of a diagnostic
 * once and writes its redacted JSON text at once (details through their own `toJSON`); the runner keeps that text and
 * a copy parsed from it, never the diagnostic itself, so what a run retains for its diagnostics is bounded by the
 * document limit however many or however large the diagnostics it is given (see `createDocumentOutput`).
 */
export interface DocumentDiagnostics {
  /** True once no further diagnostic could be kept: the runner stops reading them and reports the rest dropped. */
  full(): boolean;
  /**
   * Keeps `input` when it is a usable diagnostic whose text fits what is left; anything else is dropped with a fixed
   * warning when the document is printed. Never throws. When `full()`, the input is not read and counts as dropped.
   */
  add(input: unknown): void;
  /** Counts a returned diagnostic that could not be read (one fixed warning each). */
  unreadable(): void;
  /** Records that diagnostics were left unread because the document could keep no more (one warning). */
  drop(): void;
  /**
   * The kept diagnostics as the document prints them, each parsed from its redacted text when it is first listed:
   * code, severity, message, path and details (sensitive keys hold "[REDACTED]", projections already applied). Details
   * are listed while their copies fit an allowance of about the document's size in bytes; past it, a diagnostic is
   * listed without them, though the document still prints them. The same array each call.
   */
  list(): readonly Diagnostic[];
}

/**
 * Adds the diagnostics an action returned (declared `readonly Diagnostic[]`), reading no more than the document can
 * keep. Only an array is read: a value Array.isArray accepts, which sees through proxies and realms. Its length is
 * read once and converted by the bounded ToLength of `json-value.ts` (a length whose primitive is a numeric string
 * longer than MAX_NUMERIC_STRING_LENGTH makes the list one unreadable entry before the string is read), and each
 * index is read once, only while `collector.full()` is false, so an oversized, sparse or proxied array is cut once
 * the document's bounds are reached (see `DocumentDiagnostics`). Any other value, including a string, a String object
 * (proxied or not, from any realm), a generator or another iterable, is one unreadable entry with the fixed warning:
 * no iterator is ever opened, so nothing is iterated as characters or generated without bound. Reading them never
 * fails the run: an entry that cannot be read (a throwing index getter) is counted as unreadable and its siblings are
 * still read; a list whose length cannot be read or converted ends there with one unreadable entry. Holes and other
 * values that are not diagnostics are dropped by the collector with its fixed warning. Internal: this module is not
 * exported from the package.
 */
export function addReturnedDiagnostics(returned: unknown, collector: DocumentDiagnostics): void {
  if (returned === undefined || returned === null) {
    return;
  }
  try {
    if (!Array.isArray(returned)) {
      collector.unreadable();
      return;
    }
    const length = toLength(Reflect.get(returned, "length"));
    for (let index = 0; index < length; index += 1) {
      if (collector.full()) {
        collector.drop();
        return;
      }
      let diagnostic: unknown;
      try {
        diagnostic = Reflect.get(returned, String(index));
      } catch {
        collector.unreadable();
        continue;
      }
      collector.add(diagnostic);
    }
  } catch {
    // The list itself could not be read (a revoked proxy, or a length that cannot be read or converted): one
    // unreadable entry stands for the rest.
    collector.unreadable();
  }
}

export interface DocumentOutput {
  readonly service: OutputService;
  readonly diagnostics: DocumentDiagnostics;
  /**
   * Writes the single result document to stdout, with the kept diagnostics that fit after its data or error, and
   * returns the run's exit code.
   */
  finish(outcome: DocumentOutcome): number;
  /**
   * Writes the fixed CLIFN_RUNNER_FAILED document for a result that could not be read, after warning for each
   * collected output call, none of which is printed, and returns exit code 1.
   */
  failPreparation(): number;
}

/** Printed instead of an error message whose text does not fit the result document. */
export const MESSAGE_TOO_LONG = "The error message was too long to print.";
/** The message of the document printed when the result document could not be prepared. */
export const SERIALIZATION_FAILURE_MESSAGE = "Unable to serialize the result document";

/**
 * The fixed document itself, written as text: no object is serialized for it, so nothing inherited (such as an
 * `Object.prototype.toJSON`) can change it.
 */
const SERIALIZATION_FAILURE_TEXT =
  '{"ok":false,"error":{"code":"CLIFN_RUNNER_FAILED","message":"Unable to serialize the result document"}}\n';

/** The text of `{"ok":true,"data":}` and of `{"ok":false,"error":{"code":,"message":}}` around their values. */
const SUCCESS_FRAME_LENGTH = '{"ok":true,"data":}'.length;
const FAILURE_FRAME_LENGTH = '{"ok":false,"error":{"code":,"message":}}'.length;
/** The text `,"diagnostics":[]` adds, and `,"details":` in an error or a diagnostic. */
const DIAGNOSTICS_MEMBER_LENGTH = ',"diagnostics":[]'.length;
const DETAILS_MEMBER_LENGTH = ',"details":'.length;
/** The shortest text a printed diagnostic takes, with its separator. */
const MIN_DIAGNOSTIC_LENGTH = '{"code":"","severity":"","message":""},'.length;
/**
 * What each character of a diagnostic's details text costs against the allowance for the copies `list()` returns:
 * parsed JSON takes up to about 20 bytes for each character it was parsed from (arrays of empty arrays, objects of
 * distinct shapes), so with an allowance of `limit` units the parsed details take at most about as many bytes as the
 * document has characters. The rest of a copy (code, severity, message and path) takes about the bytes of its text.
 */
const COPY_UNITS_PER_DETAILS_CHAR = 32;
/**
 * How many warnings of one kind (unused output calls, dropped diagnostics) stderr receives; past it, one more line
 * says the rest were not reported, so the warnings stay bounded however many calls or diagnostics there are.
 */
export const MAX_WARNINGS_PER_KIND = 20;

/**
 * The budgets of one document: its text (given back when a segment is dropped) and its work for what prints nothing
 * (never given back), including the text of each segment that was written and then dropped.
 */
interface Budgets {
  text: DocumentBudget;
  work: WorkBudget;
}

/** A copy of the text budget that a segment of the document charges; the caller keeps it only when it keeps the segment. */
function segmentOf(budget: DocumentBudget): DocumentBudget {
  return { charsLeft: budget.charsLeft };
}

/**
 * Charges `consumed` characters of a segment that was written and then dropped to the work budget, without throwing:
 * the text budget gives them back, the work budget keeps them, so the next charge fails once the work is spent.
 */
function chargeDropped(work: WorkBudget, consumed: number): void {
  chargeWork(work, "dropped", Math.max(0, consumed), false, "record");
}

/**
 * Charges and returns the JSON text of the string `text`, or throws a RangeError when it does not fit what is left of
 * the text budget; no text is built for a string that does not fit (see `encodeString`). A kept string costs its text;
 * when its segment is dropped later, that text is charged to the work budget (see `chargeDropped`). A string rejected
 * from its length costs the work budget its length, at most `maxCharge` (the document limit), so strings dropped for
 * size use up the work allowance in proportion to their size, and reading stops when it is spent.
 */
function chargeString(text: string, budgets: Budgets, maxCharge: number): string {
  const room = budgets.text.charsLeft;
  const encoded = encodeString(text, room, budgets.work);
  if (encoded === undefined) {
    if (text.length + 2 > room) {
      // A string scanned and found too long was charged by the scan (see `encodeString`).
      chargeWork(budgets.work, "rejected", Math.min(text.length, maxCharge), false, "record");
    }
    throw new DocumentBudgetExceeded("Value too large for a result document");
  }
  spendText(budgets.text, encoded.length);
  return encoded;
}

const functionToString = Function.prototype.toString;
/** What `Function.prototype.toString` returns for the built-in `Object` constructor of any realm. */
const NATIVE_OBJECT_SOURCE = Reflect.apply(functionToString, Object, []) as string;

/**
 * Whether `prototype` is %Object.prototype% of some realm (this one or another, such as a `vm` context), checked
 * without running code: it is not a Proxy, has no prototype, and its own `constructor` is a data property holding the
 * built-in `Object` (not a Proxy, native source text) whose own `prototype` data property is `prototype` again.
 */
function isObjectPrototype(prototype: object): boolean {
  if (prototype === Object.prototype) {
    return true;
  }
  if (types.isProxy(prototype) || Reflect.getPrototypeOf(prototype) !== null) {
    return false;
  }
  const constructor: unknown = Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  if (typeof constructor !== "function" || types.isProxy(constructor)) {
    return false;
  }
  return (
    Reflect.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype &&
    Reflect.apply(functionToString, constructor, []) === NATIVE_OBJECT_SOURCE
  );
}

/**
 * A plain object of any realm: not an array, with a null prototype or the realm's %Object.prototype% (see
 * `isObjectPrototype`). Class instances, Maps and other built-ins are not plain.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || isObjectPrototype(prototype);
}

/**
 * The `data` member, redacted as it is written (see `serializeJsonMember`). A value JSON drops (undefined, a function,
 * a symbol, or a `toJSON` that returns one of those for the key `data`) prints null. A value that throws or does not
 * fit is rethrown, so the caller prints the serialization-failure document.
 */
function toDocumentData(data: unknown, budgets: Budgets): JsonText {
  const text = serializeJsonMember("data", data, {
    budget: budgets.text,
    work: budgets.work,
    isSensitive: isDocumentSensitiveKey,
  });
  if (text !== undefined) {
    return text;
  }
  spendText(budgets.text, "null".length);
  const nullText = new JsonText();
  nullText.write("null");
  return nullText;
}

/**
 * Writes `details` as the `"details":{...}` text of an error or diagnostic, redacted as it is written, when it
 * serializes to a JSON object that fits: anything else (a value that does not project to an object, text or work that
 * does not fit, or, unless `rethrow`, a throwing getter or toJSON) is left out: its text is given back to the text
 * budget and charged to the work budget, and the work it took stays spent. With `rethrow`, a getter or toJSON that
 * throws is rethrown, so the diagnostic is dropped.
 */
function toDocumentDetails(
  details: unknown,
  budgets: Budgets,
  separator: boolean,
  rethrow: boolean
): JsonText | undefined {
  const segment = segmentOf(budgets.text);
  let kept = false;
  try {
    spendText(segment, separator ? DETAILS_MEMBER_LENGTH : DETAILS_MEMBER_LENGTH - 1);
    const text = serializeJsonMember("details", details, {
      budget: segment,
      work: budgets.work,
      isSensitive: isDocumentSensitiveKey,
    });
    if (text?.first !== "{") {
      return undefined;
    }
    budgets.text.charsLeft = segment.charsLeft;
    kept = true;
    const member = new JsonText();
    member.write(separator ? ',"details":' : '"details":');
    member.append(text);
    return member;
  } catch (error) {
    if (rethrow && !(error instanceof DocumentBudgetExceeded)) {
      throw error;
    }
    // Left out; the caller keeps the rest.
    return undefined;
  } finally {
    if (!kept) {
      chargeDropped(budgets.work, budgets.text.charsLeft - segment.charsLeft);
    }
  }
}

/**
 * Writes a diagnostic as the JSON text the document prints, without its closing brace. It keeps the members
 * `createDiagnostic` keeps, reading each from the original diagnostic once, without cloning. The code, severity,
 * message and path are strings written directly, never through a prototype or `toJSON`; the details serialize through
 * their own `toJSON` and are kept only when they serialize to an object that fits (see `toDocumentDetails`). Throws
 * when the diagnostic is not an object, its code or message is not a string, its severity is not error, warning or
 * info, its path is neither a string nor undefined, or those members do not fit `budgets` (see `chargeString` for `maxCharge`).
 */
function toDocumentDiagnostic(
  diagnostic: Diagnostic,
  budgets: Budgets,
  maxCharge: number
): { head: JsonText; details?: JsonText } {
  const { code, severity, message, path, details } = diagnostic;
  if (
    typeof code !== "string" ||
    (severity !== "error" && severity !== "warning" && severity !== "info") ||
    typeof message !== "string" ||
    (path !== undefined && typeof path !== "string")
  ) {
    throw new TypeError("diagnostic is not usable");
  }
  const text = new JsonText();
  spendText(budgets.text, '{"code":,"severity":,"message":}'.length);
  text.write(`{"code":${chargeString(code, budgets, maxCharge)}`);
  text.write(`,"severity":${chargeString(severity, budgets, maxCharge)}`);
  text.write(`,"message":${chargeString(message, budgets, maxCharge)}`);
  if (path !== undefined) {
    spendText(budgets.text, ',"path":'.length);
    text.write(`,"path":${chargeString(path, budgets, maxCharge)}`);
  }
  // The closing brace was charged with the frame above; the caller writes it after the details or without them.
  return { head: text, details: toDocumentDetails(details || undefined, budgets, true, true) };
}

/**
 * Charges the exact JSON text of the code and message to `budget`. A message that does not fit becomes
 * MESSAGE_TOO_LONG, and a code that leaves no room even for that becomes CLIFN_RUNNER_FAILED; the exit code is kept.
 */
function chargeErrorText(payload: RunnerErrorPayload, budgets: Budgets): { codeText: string; messageText: string } {
  const budget = budgets.text;
  // The error is written first, while the work budget is still whole. A code or message that is not a string (which
  // classification never returns) takes the same fixed fallbacks, so the message printed is always a string.
  let codeText = typeof payload.code === "string" ? encodeString(payload.code, budget.charsLeft, budgets.work) : undefined;
  let messageText =
    codeText === undefined || typeof payload.message !== "string"
      ? undefined
      : encodeString(payload.message, budget.charsLeft - codeText.length, budgets.work);
  if (codeText === undefined || messageText === undefined) {
    messageText = JSON.stringify(MESSAGE_TOO_LONG);
    if (codeText === undefined || budget.charsLeft - codeText.length < messageText.length) {
      codeText = JSON.stringify(RUNNER_FAILED_CODE);
    }
  }
  spendText(budget, codeText.length + messageText.length);
  return { codeText, messageText };
}

/**
 * The error member of a failure document: the code, message and exit code from `classifyRunnerFailure` (CLI-12), and
 * the thrown value's `details` when it is a plain object that serializes to an object within the budgets, redacted.
 */
function toDocumentError(thrown: unknown, budgets: Budgets): { text: JsonText; exitCode: number } {
  // A message longer than the text left could not print as a code either, so it is not matched against the
  // message-code pattern (which would flatten it); it then falls back to MESSAGE_TOO_LONG from its length alone.
  const classified = classifyRunnerFailure(thrown, Math.max(0, budgets.text.charsLeft));
  const { codeText, messageText } = chargeErrorText(classified.error, budgets);
  const text = new JsonText();
  text.write(`{"code":${codeText},"message":${messageText}`);
  let plain = false;
  try {
    // Inside the try: a proxy whose getPrototypeOf trap throws only makes the details unusable.
    plain = isPlainObject(classified.details);
  } catch {
    plain = false;
  }
  const detailsText = plain ? toDocumentDetails(classified.details, budgets, true, false) : undefined;
  if (detailsText !== undefined) {
    text.append(detailsText);
  }
  text.write("}");
  return { text, exitCode: classified.exitCode };
}

/**
 * The output service for `jsonStyle: 'document'` (D8): every message is a JSON line on stderr, `json` and `table`
 * calls are collected instead of printed, and `finish` prints the one result document on stdout.
 */
export function createDocumentOutput(options: DocumentOutputOptions): DocumentOutput {
  // Read once, for the messages and the advisory warnings alike.
  const quiet = options.quiet ?? false;
  // Messages keep the 'lines' JSON shape and the quiet and verbose rules; only their stream changes. Like every other
  // stderr line in this mode they are advisory: a writer that throws loses the message, never the result document or
  // its exit code, and its exception never reaches stdout.
  const logWriter = (text: string) => {
    try {
      options.stderr(text);
    } catch {
      // The message is lost; the result document still reports the run.
    }
  };
  const logs = createOutput({
    mode: "json",
    quiet,
    verbose: options.verbose,
    color: options.color,
    stdout: logWriter,
    stderr: logWriter,
  });
  // The whole call is guarded too, not only the writer: formatting a message (such as an inherited toJSON that the
  // JSON line runs) can throw as well, and still loses only that message.
  const advisory =
    (log: (message: string, details?: unknown) => void) =>
    (...args: [message: string, details?: unknown]): void => {
      try {
        log(...args);
      } catch {
        // The message is lost; the result document still reports the run.
      }
    };
  const debug = advisory(logs.debug);
  const info = advisory(logs.info);
  const success = advisory(logs.success);
  const warn = advisory(logs.warn);
  const error = advisory(logs.error);
  // Collected output calls: only the value of the last json() call is kept (it may become the data), with the
  // kinds of the first calls, enough to warn for each unused one up to MAX_WARNINGS_PER_KIND and once for the rest.
  const calls: Array<"json" | "table"> = [];
  let callCount = 0;
  let lastJson = -1;
  let lastJsonValue: unknown;
  const collect = (call: "json" | "table") => {
    if (calls.length < MAX_WARNINGS_PER_KIND + 2) {
      calls.push(call);
    }
    callCount += 1;
  };
  const limit = options.maxLength ?? documentLimit();
  const maxDiagnostics = Math.max(0, Math.floor((limit - DIAGNOSTICS_MEMBER_LENGTH) / MIN_DIAGNOSTIC_LENGTH));

  const spinner = (message: string): Spinner => ({
    start() {},
    stop() {},
    succeed(nextMessage) {
      success(nextMessage || message);
    },
    fail(nextMessage) {
      error(nextMessage || message);
    },
  });

  const service: OutputService = {
    mode: "json",
    debug,
    info,
    success,
    warn,
    error,
    json(value) {
      lastJson = callCount;
      lastJsonValue = value;
      collect("json");
    },
    table() {
      collect("table");
    },
    spinner,
  };

  // Advisory stderr lines: a writer that throws on one cannot change the result document or the exit code. Each is a
  // fixed warn line written as text, the shape `logs.warn` prints, so nothing inherited can change it; quiet skips it.
  const advise = (message: string) => {
    if (quiet) {
      return;
    }
    try {
      options.stderr(`{"level":"warn","message":${JSON.stringify(message)}}\n`);
    } catch {
      // The warning is lost; the result document still reports the run.
    }
  };
  // Advises once for each of the first MAX_WARNINGS_PER_KIND items, then once for the rest.
  const boundedAdvice = (rest: string) => {
    let count = 0;
    return {
      add(message: string) {
        count += 1;
        if (count <= MAX_WARNINGS_PER_KIND) {
          advise(message);
        } else if (count === MAX_WARNINGS_PER_KIND + 1) {
          advise(rest);
        }
      },
    };
  };

  // Warns for every collected call except the one at index `used` (-1 for none).
  const warnUnused = (used: number) => {
    const advice = boundedAdvice("further output.json() and output.table() calls were not printed either");
    calls.forEach((call, index) => {
      if (index !== used) {
        advice.add(`output.${call}() was not printed: document mode prints one result document; return the value as data`);
      }
    });
  };

  // Diagnostics are written when they are added, each read once, under budgets of their own that bound what the run
  // retains for them: their text (at most what a document could print after its smallest data) and the work that
  // prints nothing (twice the limit, as for the document); the copies `list()` returns are bounded by their own
  // allowance (see COPY_UNITS_PER_DETAILS_CHAR). At most `maxDiagnostics` are read. A diagnostic that cannot be
  // written (not an object, a member that is not a string, a throwing getter or toJSON, or text longer than is left)
  // is dropped with a fixed warning when the document is printed, so it cannot cost the run its result document.
  const kept: Budgets = {
    text: createDocumentBudget(Math.max(0, limit - 1 - SUCCESS_FRAME_LENGTH - "0".length - DIAGNOSTICS_MEMBER_LENGTH)),
    work: createWorkBudget(limit),
  };
  // Not a work allowance: the units the copies `list()` parses may use (see COPY_UNITS_PER_DETAILS_CHAR).
  let copyUnitsLeft = limit;
  // Each diagnostic kept, in the order they were added, as the document prints it without its closing brace: one
  // flat string of its `{"code":...` head followed by its `,"details":{...}` member, if any (undefined for one dropped
  // when it was added), and in `headLengths` the length of that head. So what the run retains per diagnostic is its
  // text, one string header and two array slots, a fixed overhead below its at least MIN_DIAGNOSTIC_LENGTH characters,
  // never an object or a second string for its details; with at most `maxDiagnostics` of them, the whole is bounded
  // by a small multiple of the limit, which is sized from the old generation where they live (see `documentLimit`).
  const entries: Array<string | undefined> = [];
  const headLengths: number[] = [];
  // The copies `list()` returns, parsed from the kept text the first time they are listed; `copied` entries so far.
  const copies: Diagnostic[] = [];
  let copied = 0;
  let unreadableCount = 0;
  // Diagnostics added while another was being written (from its getter or toJSON), each dropped with a warning.
  let reentrantCount = 0;
  let preparing = false;
  let droppedRest = false;
  const consumed = () => entries.length + unreadableCount;
  const full = () =>
    consumed() >= maxDiagnostics ||
    workLeft(kept.work, "entry") < 1 ||
    kept.text.charsLeft < MIN_DIAGNOSTIC_LENGTH;

  const prepare = (input: unknown): void => {
    const item = segmentOf(kept.text);
    // While a diagnostic is written its text is charged to `item`, a copy of the budget kept only when it succeeds,
    // so an add from its getter or toJSON could not be charged to the same budget: it is dropped (see `add`).
    preparing = true;
    try {
      chargeWork(kept.work, "entry", 1);
      // Its separator, then its text.
      spendText(item, 1);
      const written = toDocumentDiagnostic(input as Diagnostic, { text: item, work: kept.work }, limit);
      kept.text.charsLeft = item.charsLeft;
      const head = written.head.toString();
      let text = head;
      if (written.details !== undefined) {
        // Joined into one new flat string, so neither the head nor the details text is retained apart from it.
        const whole = new JsonText();
        whole.write(head);
        whole.append(written.details);
        text = whole.toString();
      }
      entries.push(text);
      headLengths.push(head.length);
    } catch {
      chargeDropped(kept.work, kept.text.charsLeft - item.charsLeft);
      entries.push(undefined);
      headLengths.push(0);
    } finally {
      preparing = false;
    }
  };

  const diagnostics: DocumentDiagnostics = {
    full,
    add(input) {
      if (preparing) {
        // Never read: dropped with a fixed warning; one unit of work, so a getter that keeps adding stops the reading.
        chargeWork(kept.work, "entry", 1, false, "record");
        reentrantCount += 1;
        return;
      }
      if (full()) {
        droppedRest = true;
        return;
      }
      prepare(input);
    },
    unreadable() {
      if (full()) {
        droppedRest = true;
        return;
      }
      chargeWork(kept.work, "entry", 1, false, "record");
      unreadableCount += 1;
    },
    drop() {
      droppedRest = true;
    },
    list() {
      for (; copied < entries.length; copied += 1) {
        const entry = entries[copied];
        if (entry === undefined) {
          continue;
        }
        const headLength = headLengths[copied];
        let source = entry;
        if (entry.length > headLength) {
          const units = (entry.length - headLength) * COPY_UNITS_PER_DETAILS_CHAR;
          if (units <= copyUnitsLeft) {
            copyUnitsLeft -= units;
          } else {
            source = entry.slice(0, headLength);
          }
        }
        copies.push(JSON.parse(`${source}}`) as Diagnostic);
      }
      return copies;
    },
  };

  // Writes the `,"diagnostics":[...]` member from the kept text: each diagnostic that fits what the data or error left,
  // whole, or without its details when only they do not fit. `text` is undefined when none is printed; `printed`
  // marks the entries printed, for `adviseDiagnostics`.
  const writeDiagnostics = (budgets: Budgets): { text: JsonText | undefined; printed: boolean[] } => {
    let charsLeft = budgets.text.charsLeft - DIAGNOSTICS_MEMBER_LENGTH;
    const text = new JsonText();
    text.write(',"diagnostics":[');
    const printed: boolean[] = [];
    let count = 0;
    entries.forEach((entry, index) => {
      printed[index] = false;
      if (entry !== undefined) {
        const separator = count > 0 ? 1 : 0;
        const head = separator + headLengths[index] + 1;
        const whole = separator + entry.length + 1;
        if (head <= charsLeft) {
          if (count > 0) {
            text.write(",");
          }
          if (whole <= charsLeft) {
            text.write(entry);
            charsLeft -= whole;
          } else {
            text.write(entry.slice(0, headLengths[index]));
            charsLeft -= head;
          }
          text.write("}");
          printed[index] = true;
          count += 1;
        }
      }
    });
    if (count === 0) {
      return { text: undefined, printed };
    }
    budgets.text.charsLeft = charsLeft;
    text.write("]");
    return { text, printed };
  };

  // The fixed warnings for the diagnostics the printed document leaves out: unreadable, unusable or not printed ones,
  // those added while another was read, and those never read. `printed` is undefined when the fixed failure document
  // replaces the result, which prints none of them. Each kind is bounded (see `boundedAdvice`); quiet skips them all.
  const adviseDiagnostics = (printed: readonly boolean[] | undefined) => {
    const advice = boundedAdvice("further diagnostics were dropped from the result document");
    // At most `maxDiagnostics` were counted, so these loops are bounded.
    for (let index = 0; index < unreadableCount; index += 1) {
      advice.add("a returned diagnostic was dropped from the result document: it could not be read");
    }
    if (reentrantCount > 0) {
      advise(`${reentrantCount} diagnostics added while another diagnostic was being read were dropped`);
    }
    let replaced = 0;
    entries.forEach((entry, index) => {
      if (entry !== undefined && printed === undefined) {
        replaced += 1;
      } else if (entry === undefined || printed?.[index] !== true) {
        advice.add(`diagnostic ${index} was dropped from the result document: it could not be redacted or printed`);
      }
    });
    if (replaced > 0) {
      advise(`${replaced} diagnostics were dropped: the result document could not be prepared`);
    }
    if (droppedRest) {
      advise(`diagnostics past the first ${consumed()} were dropped: the result document cannot print them all`);
    }
  };

  return {
    service,
    diagnostics,
    failPreparation() {
      warnUnused(-1);
      adviseDiagnostics(undefined);
      options.stdout(SERIALIZATION_FAILURE_TEXT);
      return 1;
    },
    finish(outcome) {
      let text: string | undefined;
      let exitCode = 1;
      // One text budget for the whole document, charged at the exact length of its text: its frame, the data or the
      // error, then each kept diagnostic in order, printed whole, without its details, or not at all. The newline is
      // reserved, so a document that fits can always be written with it. A separate work budget of twice as many
      // units, never given back, bounds everything walked or written for the data or error that does not print (see
      // `WorkBudget`); the diagnostics were written under budgets of their own when they were added.
      const budgets: Budgets = { text: createDocumentBudget(limit - 1), work: createWorkBudget(limit) };
      // The json() call whose value became the data, and the diagnostics printed; warned about once the document is
      // known, so the fixed failure document warns for every call and diagnostic it leaves out.
      let used = -1;
      let printedDiagnostics: boolean[] | undefined;
      try {
        const document = new JsonText();
        if (outcome.ok) {
          let data = outcome.data;
          if (data === undefined && lastJson !== -1) {
            data = lastJsonValue;
            used = lastJson;
          }
          spendText(budgets.text, SUCCESS_FRAME_LENGTH);
          document.write('{"ok":true,"data":');
          document.append(toDocumentData(data, budgets));
          exitCode = outcome.exitCode;
        } else {
          // Not a throwing charge: a code and message that do not fit fall back to fixed ones and keep the exit code.
          budgets.text.charsLeft -= FAILURE_FRAME_LENGTH;
          const error = toDocumentError(outcome.error, budgets);
          document.write('{"ok":false,"error":');
          document.append(error.text);
          exitCode = error.exitCode;
        }

        const diagnosticsText = writeDiagnostics(budgets);
        printedDiagnostics = diagnosticsText.printed;
        if (diagnosticsText.text !== undefined) {
          document.append(diagnosticsText.text);
        }
        document.write("}\n");
        // Every piece was charged at its exact length, so this check only guards the accounting.
        const printed = document.toString();
        text = budgets.text.charsLeft >= 0 && printed.length <= limit ? printed : undefined;
      } catch {
        // A budget overrun, or anything else that failed while the document was prepared; never printed.
        text = undefined;
      }

      if (text === undefined) {
        // Whatever failed while the document was prepared, stdout still receives exactly one document.
        text = SERIALIZATION_FAILURE_TEXT;
        exitCode = 1;
        used = -1;
        printedDiagnostics = undefined;
      }
      warnUnused(used);
      adviseDiagnostics(printedDiagnostics);
      options.stdout(text);
      return exitCode;
    },
  };
}
