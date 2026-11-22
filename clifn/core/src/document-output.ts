import { redactDiagnostics, type Diagnostic } from "./diagnostics.js";
import { mapRunnerError, RUNNER_FAILED_CODE } from "./errors.js";
import { normalizeJsonValue } from "./json-value.js";
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

function serializeDocument(document: unknown): string | undefined {
  try {
    return JSON.stringify(normalizeJsonValue(document));
  } catch {
    return undefined;
  }
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

  return {
    service,
    finish(outcome, diagnostics) {
      let document: Record<string, unknown>;
      let exitCode: number;

      if (outcome.ok) {
        let data = outcome.data;
        let dropped: CollectedCall[] = collected;
        if (data === undefined) {
          const lastJson = collected.map((entry) => entry.call).lastIndexOf("json");
          data = lastJson === -1 ? null : collected[lastJson].value;
          dropped = collected.filter((_, index) => index !== lastJson);
        }
        warnDropped(dropped);
        document = { ok: true, data };
        exitCode = outcome.exitCode;
      } else {
        const mapped = mapRunnerError(outcome.error);
        warnDropped(collected);
        document = { ok: false, error: mapped.error };
        exitCode = mapped.exitCode;
      }

      if (diagnostics.length > 0) {
        document.diagnostics = redactDiagnostics(diagnostics);
      }

      let text = serializeDocument(document);
      if (text === undefined) {
        text = JSON.stringify(SERIALIZATION_FAILURE);
        exitCode = 1;
      }
      options.stdout(`${text}\n`);
      return exitCode;
    },
  };
}
