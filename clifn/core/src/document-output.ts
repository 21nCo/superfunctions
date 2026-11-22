import type { Diagnostic } from "./diagnostics.js";
import { mapRunnerError, RUNNER_FAILED_CODE } from "./errors.js";
import {
  createDocumentBudget,
  DocumentBudgetExceeded,
  JsonText,
  serializeJsonMember,
  spendText,
  type DocumentBudget,
} from "./json-value.js";
import { createOutput, type OutputService, type Spinner } from "./output.js";

export interface DocumentOutputOptions {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * The longest text to write to stdout, in characters, counting the document and its newline. Defaults to the
   * engine's maximum string length, where `JSON.stringify` throws; tests pass a smaller limit. Not part of the public
   * runner options.
   */
  maxLength?: number;
}

export type DocumentOutcome =
  | { ok: true; data: unknown; exitCode: number }
  | { ok: false; error: unknown };

export interface DocumentOutput {
  readonly service: OutputService;
  /** Writes the single result document to stdout and returns the run's exit code. */
  finish(outcome: DocumentOutcome, diagnostics: readonly Diagnostic[]): number;
}

interface CollectedCall {
  call: "json" | "table";
  value: unknown;
}

const SERIALIZATION_FAILURE = {
  ok: false,
  error: { code: RUNNER_FAILED_CODE, message: "Unable to serialize the result document" },
} as const;

/** The text of `{"ok":true,"data":}` and of `{"ok":false,"error":{"code":,"message":}}` around their values. */
const SUCCESS_FRAME_LENGTH = '{"ok":true,"data":}'.length;
const FAILURE_FRAME_LENGTH = '{"ok":false,"error":{"code":,"message":}}'.length;
/** The text `,"diagnostics":[]` adds, and `,"details":` in a diagnostic. */
const DIAGNOSTICS_MEMBER_LENGTH = ',"diagnostics":[]'.length;
const DETAILS_MEMBER_LENGTH = ',"details":'.length;

/** A copy of `budget` that a segment of the document charges; the caller keeps it only when the segment is kept. */
function segmentOf(budget: DocumentBudget): DocumentBudget {
  return { charsLeft: budget.charsLeft };
}

/**
 * The success document always has a `data` member: the value is written as the member `data` (see
 * `serializeJsonMember`), and a value JSON drops (undefined, a function, a symbol, or a `toJSON` that returns one of
 * those for that key) prints null. A value that throws while it is written is rethrown so the caller prints the
 * serialization-failure document.
 */
function toDocumentData(data: unknown, budget: DocumentBudget): JsonText {
  const text = serializeJsonMember("data", data, { budget });
  if (text !== undefined) {
    return text;
  }
  spendText(budget, "null".length);
  const nullText = new JsonText();
  nullText.write("null");
  return nullText;
}

/**
 * Writes a diagnostic as the JSON text the document prints, with its details redacted as they are written, so every
 * getter and `toJSON` in them runs as in `JSON.stringify` and none can bring a redacted field back. It keeps the
 * members `createDiagnostic` keeps, but reads them from the original diagnostic without cloning, so each value in the
 * details serializes through its own `toJSON` (a Date prints its ISO string, a class prints only what its serializer
 * returns). Details that do not serialize to an object or do not fit `budget` are left out and charge nothing.
 * Throws when the diagnostic is not an object, its details throw, or its other members cannot be serialized or do
 * not fit `budget`.
 */
function toDocumentDiagnostic(diagnostic: Diagnostic, index: number, budget: DocumentBudget): JsonText {
  const { code, severity, message, path, details } = diagnostic;
  const base = serializeJsonMember(String(index), { code, severity, message, path }, { budget })?.toString() ?? "";
  if (!base.startsWith("{")) {
    throw new TypeError("diagnostic did not serialize to an object");
  }
  const text = new JsonText();
  // The members without the closing brace, then the details, then the brace.
  text.write(base.slice(0, -1));
  const segment = segmentOf(budget);
  let detailsText: JsonText | undefined;
  try {
    spendText(segment, base.length > 2 ? DETAILS_MEMBER_LENGTH : DETAILS_MEMBER_LENGTH - 1);
    detailsText = serializeJsonMember("details", details || undefined, { budget: segment, redact: true });
  } catch (error) {
    if (!(error instanceof DocumentBudgetExceeded)) {
      throw error;
    }
  }
  if (detailsText?.first === "{") {
    budget.charsLeft = segment.charsLeft;
    text.write(base.length > 2 ? ',"details":' : '"details":');
    text.append(detailsText);
  }
  text.write("}");
  return text;
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

  const warnDropped = (calls: readonly CollectedCall[]) => {
    for (const { call } of calls) {
      logs.warn(`output.${call}() was not printed: document mode prints one result document; return the value as data`);
    }
  };

  // A diagnostic that cannot be serialized (not an object, a throwing getter or toJSON in its details, or text longer
  // than is left of the document's budget) is dropped with a warning on stderr and charges nothing, so it cannot cost
  // the run its result document. Returns the `,"diagnostics":[...]` member, or undefined when none is kept.
  const writeDiagnostics = (input: readonly Diagnostic[], budget: DocumentBudget): JsonText | undefined => {
    const segment = segmentOf(budget);
    segment.charsLeft -= DIAGNOSTICS_MEMBER_LENGTH;
    const text = new JsonText();
    text.write(',"diagnostics":[');
    let kept = 0;
    input.forEach((diagnostic, index) => {
      const item = segmentOf(segment);
      try {
        // Its separator, then its text.
        spendText(item, kept > 0 ? 1 : 0);
        const diagnosticText = toDocumentDiagnostic(diagnostic, index, item);
        if (kept > 0) {
          text.write(",");
        }
        text.append(diagnosticText);
        segment.charsLeft = item.charsLeft;
        kept += 1;
      } catch {
        logs.warn(`diagnostic ${index} was dropped from the result document: it could not be redacted or printed`);
      }
    });
    if (kept === 0) {
      return undefined;
    }
    text.write("]");
    budget.charsLeft = segment.charsLeft;
    return text;
  };

  return {
    service,
    finish(outcome, diagnostics) {
      let text: string | undefined;
      let exitCode = 1;
      // One budget for the whole document, charged at the exact length of its text: its frame, the data or the error,
      // then each diagnostic in order, each a segment that is kept whole or dropped whole. The newline is reserved, so
      // a document that fits can always be written with it.
      const maxLength = (options.maxLength ?? createDocumentBudget().charsLeft) - 1;
      const budget = createDocumentBudget(maxLength);
      try {
        const document = new JsonText();
        if (outcome.ok) {
          let data = outcome.data;
          let dropped: CollectedCall[] = collected;
          if (data === undefined) {
            const lastJson = collected.map((entry) => entry.call).lastIndexOf("json");
            data = lastJson === -1 ? null : collected[lastJson].value;
            dropped = collected.filter((_, index) => index !== lastJson);
          }
          warnDropped(dropped);
          spendText(budget, SUCCESS_FRAME_LENGTH);
          document.write('{"ok":true,"data":');
          document.append(toDocumentData(data, budget));
          exitCode = outcome.exitCode;
        } else {
          budget.charsLeft -= FAILURE_FRAME_LENGTH;
          const mapped = mapRunnerError(outcome.error, budget);
          warnDropped(collected);
          document.write(`{"ok":false,"error":{"code":${mapped.codeText},"message":${mapped.messageText}`);
          if (mapped.details !== undefined) {
            document.write(',"details":');
            document.append(mapped.details);
          }
          document.write("}");
          exitCode = mapped.exitCode;
        }

        const diagnosticsText = writeDiagnostics(diagnostics, budget);
        if (diagnosticsText !== undefined) {
          document.append(diagnosticsText);
        }
        document.write("}\n");
        // Every piece was charged at its exact length, so this check only guards the accounting.
        const printed = document.toString();
        text = budget.charsLeft >= 0 && printed.length <= maxLength + 1 ? printed : undefined;
      } catch {
        text = undefined;
      }

      if (text === undefined) {
        // Whatever failed while the document was prepared, stdout still receives exactly one document.
        text = `${JSON.stringify(SERIALIZATION_FAILURE)}\n`;
        exitCode = 1;
      }
      options.stdout(text);
      return exitCode;
    },
  };
}
