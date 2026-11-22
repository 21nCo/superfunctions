import { redactValue, type Diagnostic } from "./diagnostics.js";
import { mapRunnerError, RUNNER_FAILED_CODE } from "./errors.js";
import { resolveJsonMember } from "./json-value.js";
import { createOutput, type OutputService, type Spinner } from "./output.js";

export interface DocumentOutputOptions {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The success document always has a `data` member: the value is resolved as the member `data` (see
 * `resolveJsonMember`), and a value JSON drops (undefined, a function, a symbol, or a `toJSON` that returns one of
 * those for that key) becomes null. A value that throws while it is resolved is rethrown so the caller prints the
 * serialization-failure document.
 */
function toDocumentData(data: unknown): unknown {
  return resolveJsonMember("data", data) ?? null;
}

/**
 * Resolves a diagnostic to the JSON value the document prints, then redacts its details, so a `toJSON` in the
 * details cannot bring a redacted field back. It keeps the members `createDiagnostic` keeps, but reads them from the
 * original diagnostic without cloning, so each value in the details serializes through its own `toJSON` (a Date
 * prints its ISO string, a class prints only what its serializer returns). Details that do not resolve to an object
 * are left out. Throws when the diagnostic is not an object or cannot be serialized.
 */
function toDocumentDiagnostic(diagnostic: Diagnostic, index: number): Record<string, unknown> {
  const { code, severity, message, path, details } = diagnostic;
  const resolved = resolveJsonMember(String(index), {
    code,
    severity,
    message,
    path,
    details: details || undefined,
  });
  if (!isJsonObject(resolved)) {
    throw new TypeError("diagnostic did not resolve to an object");
  }
  if (isJsonObject(resolved.details)) {
    resolved.details = redactValue(resolved.details);
  } else {
    delete resolved.details;
  }
  return resolved;
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

  // A diagnostic that cannot be resolved or redacted (not an object, or a throwing getter or toJSON in its details)
  // is dropped with a warning on stderr, so it cannot cost the run its result document.
  const redactEach = (input: readonly Diagnostic[]): Array<Record<string, unknown>> => {
    const redacted: Array<Record<string, unknown>> = [];
    input.forEach((diagnostic, index) => {
      try {
        redacted.push(toDocumentDiagnostic(diagnostic, index));
      } catch {
        logs.warn(`diagnostic ${index} was dropped from the result document: it could not be redacted`);
      }
    });
    return redacted;
  };

  return {
    service,
    finish(outcome, diagnostics) {
      let text: string | undefined;
      let exitCode = 1;
      try {
        let document: Record<string, unknown>;
        if (outcome.ok) {
          let data = outcome.data;
          let dropped: CollectedCall[] = collected;
          if (data === undefined) {
            const lastJson = collected.map((entry) => entry.call).lastIndexOf("json");
            data = lastJson === -1 ? null : collected[lastJson].value;
            dropped = collected.filter((_, index) => index !== lastJson);
          }
          warnDropped(dropped);
          document = { ok: true, data: toDocumentData(data) };
          exitCode = outcome.exitCode;
        } else {
          const mapped = mapRunnerError(outcome.error);
          warnDropped(collected);
          document = { ok: false, error: mapped.error };
          exitCode = mapped.exitCode;
        }

        const redacted = redactEach(diagnostics);
        if (redacted.length > 0) {
          document.diagnostics = redacted;
        }
        // Every member is already a plain JSON value, so this runs no user code and drops or restores nothing.
        text = JSON.stringify(document);
      } catch {
        text = undefined;
      }

      if (text === undefined) {
        // Whatever failed while the document was prepared, stdout still receives exactly one document.
        text = JSON.stringify(SERIALIZATION_FAILURE);
        exitCode = 1;
      }
      options.stdout(`${text}\n`);
      return exitCode;
    },
  };
}
