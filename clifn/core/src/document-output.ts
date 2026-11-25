import type { Diagnostic } from "./diagnostics.js";
import { classifyRunnerFailure, RUNNER_FAILED_CODE, type RunnerErrorPayload } from "./errors.js";
import {
  createDocumentBudget,
  createWorkBudget,
  DocumentBudgetExceeded,
  documentLimit,
  encodeString,
  JsonText,
  serializeJsonMember,
  spendText,
  spendWork,
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

export interface DocumentOutput {
  readonly service: OutputService;
  /**
   * The most diagnostics one document can print, each at its smallest (`{"code":"","severity":"","message":""}` and
   * a separator). The runner keeps at most this many and reports the rest as dropped.
   */
  readonly maxDiagnostics: number;
  /**
   * Writes the single result document to stdout and returns the run's exit code. `droppedDiagnostics` reports that
   * diagnostics past `maxDiagnostics` were left out before they were read; it adds one warning on stderr.
   */
  finish(outcome: DocumentOutcome, diagnostics: readonly Diagnostic[], droppedDiagnostics?: boolean): number;
  /** Writes the fixed CLIFN_RUNNER_FAILED document for a result that could not be read, and returns exit code 1. */
  failPreparation(): number;
}

interface CollectedCall {
  call: "json" | "table";
  value: unknown;
}

/** Printed instead of an error message whose text does not fit the result document. */
export const MESSAGE_TOO_LONG = "The error message was too long to print.";
/** The message of the document printed when the result document could not be prepared. */
export const SERIALIZATION_FAILURE_MESSAGE = "Unable to serialize the result document";

const SERIALIZATION_FAILURE_TEXT = `${JSON.stringify({
  ok: false,
  error: { code: RUNNER_FAILED_CODE, message: SERIALIZATION_FAILURE_MESSAGE },
})}\n`;

/** The text of `{"ok":true,"data":}` and of `{"ok":false,"error":{"code":,"message":}}` around their values. */
const SUCCESS_FRAME_LENGTH = '{"ok":true,"data":}'.length;
const FAILURE_FRAME_LENGTH = '{"ok":false,"error":{"code":,"message":}}'.length;
/** The text `,"diagnostics":[]` adds, and `,"details":` in an error or a diagnostic. */
const DIAGNOSTICS_MEMBER_LENGTH = ',"diagnostics":[]'.length;
const DETAILS_MEMBER_LENGTH = ',"details":'.length;
/** The shortest text a printed diagnostic takes, with its separator. */
const MIN_DIAGNOSTIC_LENGTH = '{"code":"","severity":"","message":""},'.length;
/**
 * How many warnings of one kind (unused output calls, dropped diagnostics) stderr receives; past it, one more line
 * says the rest were not reported, so the warnings stay bounded however many calls or diagnostics there are.
 */
export const MAX_WARNINGS_PER_KIND = 20;

/** The budgets of one document: its text (given back when a segment is dropped) and its work (never given back). */
interface Budgets {
  text: DocumentBudget;
  work: WorkBudget;
}

/** A copy of the text budget that a segment of the document charges; the caller keeps it only when it keeps the segment. */
function segmentOf(budget: DocumentBudget): DocumentBudget {
  return { charsLeft: budget.charsLeft };
}

/**
 * Charges and returns the JSON text of the string `text`, or throws a RangeError when it does not fit what is left of
 * the budgets; no text is built for a string that does not fit (see `encodeString`).
 */
function chargeString(text: string, budgets: Budgets): string {
  const encoded = encodeString(text, budgets.text.charsLeft, budgets.work);
  if (encoded === undefined) {
    throw new DocumentBudgetExceeded("Value too large for a result document");
  }
  spendText(budgets.text, encoded.length);
  return encoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
 * does not fit, or, unless `rethrow`, a throwing getter or toJSON) is left out and its text charges nothing; the work
 * it took stays spent. With `rethrow`, a getter or toJSON that throws is rethrown, so the diagnostic is dropped.
 */
function toDocumentDetails(
  details: unknown,
  budgets: Budgets,
  separator: boolean,
  rethrow: boolean
): JsonText | undefined {
  const segment = segmentOf(budgets.text);
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
  }
}

/**
 * Writes a diagnostic as the JSON text the document prints. It keeps the members `createDiagnostic` keeps, reading
 * each from the original diagnostic once, without cloning. The code, severity, message and path are strings written
 * directly, never through a prototype or `toJSON`; the details serialize through their own `toJSON` and are kept only
 * when they serialize to an object that fits (see `toDocumentDetails`). Throws when the diagnostic is not an object,
 * its code, severity or message is not a string, its path is neither a string nor undefined, or those members do not
 * fit `budgets`.
 */
function toDocumentDiagnostic(diagnostic: Diagnostic, budgets: Budgets): JsonText {
  const { code, severity, message, path, details } = diagnostic;
  if (
    typeof code !== "string" ||
    typeof severity !== "string" ||
    typeof message !== "string" ||
    (path !== undefined && typeof path !== "string")
  ) {
    throw new TypeError("diagnostic is not usable");
  }
  const text = new JsonText();
  spendText(budgets.text, '{"code":,"severity":,"message":}'.length);
  text.write(`{"code":${chargeString(code, budgets)}`);
  text.write(`,"severity":${chargeString(severity, budgets)}`);
  text.write(`,"message":${chargeString(message, budgets)}`);
  if (path !== undefined) {
    spendText(budgets.text, ',"path":'.length);
    text.write(`,"path":${chargeString(path, budgets)}`);
  }
  const detailsText = toDocumentDetails(details || undefined, budgets, true, true);
  if (detailsText !== undefined) {
    text.append(detailsText);
  }
  text.write("}");
  return text;
}

/**
 * Charges the exact JSON text of the code and message to `budget`. A message that does not fit becomes
 * MESSAGE_TOO_LONG, and a code that leaves no room even for that becomes CLIFN_RUNNER_FAILED; the exit code is kept.
 */
function chargeErrorText(payload: RunnerErrorPayload, budgets: Budgets): { codeText: string; messageText: string } {
  const budget = budgets.text;
  let codeText = encodeString(payload.code, budget.charsLeft, budgets.work);
  let messageText =
    codeText === undefined ? undefined : encodeString(payload.message, budget.charsLeft - codeText.length, budgets.work);
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
  const classified = classifyRunnerFailure(thrown);
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
  // Messages keep the 'lines' JSON shape and the quiet and verbose rules; only their stream changes.
  const logs = createOutput({
    mode: "json",
    quiet: options.quiet,
    verbose: options.verbose,
    color: options.color,
    stdout: options.stderr,
    stderr: options.stderr,
  });
  const collected: CollectedCall[] = [];
  const limit = options.maxLength ?? documentLimit();
  const maxDiagnostics = Math.max(0, Math.floor((limit - DIAGNOSTICS_MEMBER_LENGTH) / MIN_DIAGNOSTIC_LENGTH));

  const spinner = (message: string): Spinner => ({
    start() {},
    stop() {},
    succeed(nextMessage) {
      logs.success(nextMessage || message);
    },
    fail(nextMessage) {
      logs.error(nextMessage || message);
    },
  });

  const service: OutputService = {
    mode: "json",
    debug: logs.debug,
    info: logs.info,
    success: logs.success,
    warn: logs.warn,
    error: logs.error,
    json(value) {
      collected.push({ call: "json", value });
    },
    table(input) {
      collected.push({ call: "table", value: input });
    },
    spinner,
  };

  // Advisory stderr lines: a writer that throws on one cannot change the result document or the exit code.
  const advise = (message: string) => {
    try {
      logs.warn(message);
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

  const warnUnused = (calls: readonly CollectedCall[]) => {
    const advice = boundedAdvice("further output.json() and output.table() calls were not printed either");
    for (const { call } of calls) {
      advice.add(`output.${call}() was not printed: document mode prints one result document; return the value as data`);
    }
  };

  // A diagnostic that cannot be serialized (not an object, a throwing getter or toJSON in its members, or text longer
  // than is left of the document's budget) is dropped with a fixed warning on stderr, so it cannot cost the run its
  // result document. Each diagnostic costs one unit of work before it is read, and at most `maxDiagnostics` are read.
  // Returns the `,"diagnostics":[...]` member, or undefined when none is kept.
  const writeDiagnostics = (input: readonly Diagnostic[], dropped: boolean, budgets: Budgets): JsonText | undefined => {
    const segment = segmentOf(budgets.text);
    segment.charsLeft -= DIAGNOSTICS_MEMBER_LENGTH;
    const text = new JsonText();
    text.write(',"diagnostics":[');
    const advice = boundedAdvice("further diagnostics were dropped from the result document");
    const count = Math.min(input.length, maxDiagnostics);
    let kept = 0;
    for (let index = 0; index < count; index += 1) {
      const item = segmentOf(segment);
      try {
        spendWork(budgets.work, 1);
        // Its separator, then its text.
        spendText(item, kept > 0 ? 1 : 0);
        const diagnosticText = toDocumentDiagnostic(input[index], { text: item, work: budgets.work });
        if (kept > 0) {
          text.write(",");
        }
        text.append(diagnosticText);
        segment.charsLeft = item.charsLeft;
        kept += 1;
      } catch {
        advice.add(`diagnostic ${index} was dropped from the result document: it could not be redacted or printed`);
      }
    }
    if (dropped || input.length > count) {
      advise(`diagnostics past the first ${maxDiagnostics} were dropped: the result document cannot print them all`);
    }
    if (kept === 0 || segment.charsLeft < 0) {
      return undefined;
    }
    budgets.text.charsLeft = segment.charsLeft;
    text.write("]");
    return text;
  };

  return {
    service,
    maxDiagnostics,
    failPreparation() {
      options.stdout(SERIALIZATION_FAILURE_TEXT);
      return 1;
    },
    finish(outcome, diagnostics, droppedDiagnostics = false) {
      let text: string | undefined;
      let exitCode = 1;
      // One text budget for the whole document, charged at the exact length of its text: its frame, the data or the
      // error, then each diagnostic in order, each a segment that is kept whole or dropped whole. The newline is
      // reserved, so a document that fits can always be written with it. One work budget, never given back, bounds
      // everything walked to prepare it, kept or not.
      const budgets: Budgets = { text: createDocumentBudget(limit - 1), work: createWorkBudget(limit) };
      try {
        const document = new JsonText();
        if (outcome.ok) {
          let data = outcome.data;
          let unused: CollectedCall[] = collected;
          if (data === undefined) {
            const lastJson = collected.map((entry) => entry.call).lastIndexOf("json");
            data = lastJson === -1 ? undefined : collected[lastJson].value;
            unused = collected.filter((_, index) => index !== lastJson);
          }
          warnUnused(unused);
          spendText(budgets.text, SUCCESS_FRAME_LENGTH);
          document.write('{"ok":true,"data":');
          document.append(toDocumentData(data, budgets));
          exitCode = outcome.exitCode;
        } else {
          warnUnused(collected);
          // Not a throwing charge: a code and message that do not fit fall back to fixed ones and keep the exit code.
          budgets.text.charsLeft -= FAILURE_FRAME_LENGTH;
          const error = toDocumentError(outcome.error, budgets);
          document.write('{"ok":false,"error":');
          document.append(error.text);
          exitCode = error.exitCode;
        }

        const diagnosticsText = writeDiagnostics(diagnostics, droppedDiagnostics, budgets);
        if (diagnosticsText !== undefined) {
          document.append(diagnosticsText);
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
      }
      options.stdout(text);
      return exitCode;
    },
  };
}
