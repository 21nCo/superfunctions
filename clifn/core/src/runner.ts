import type { Diagnostic } from "./diagnostics.js";
import {
  addReturnedDiagnostics,
  createDocumentOutput,
  type DocumentOutcome,
  type DocumentOutput,
} from "./document-output.js";
import { createExec, type ExecService } from "./exec.js";
import { createOutput, type OutputService } from "./output.js";
import { createScaffold, type ScaffoldService } from "./scaffold.js";
import type { UpdateCheck } from "./update-check.js";

export interface RunnerDiagnosticsSink {
  add(input: Diagnostic): void;
  list(): readonly Diagnostic[];
}

export type RunnerDiagnosticsListener = (diagnostics: readonly Diagnostic[]) => void;

/**
 * How `mode: 'json'` writes output. `'lines'` (the default) prints each message and value as its own JSON line.
 * `'document'` prints exactly one result document on stdout (D8), `{"ok":true,"data":...}` or
 * `{"ok":false,"error":{"code","message","details"?}}` with `diagnostics` when there are any, and writes every
 * message as a JSON line to stderr. Sensitive keys in `data`, error `details` and diagnostic `details` print
 * `"[REDACTED]"`; messages print as given. Diagnostics are kept as the document prints them, so
 * `ctx.diagnostics.list()` and `onDiagnostics` receive redacted copies, not the objects given. It has no effect in
 * text mode.
 */
export type RunnerJsonStyle = "lines" | "document";

export interface RunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  /** Colour for text written to stderr (errors and the spinner) when it differs from stdout. Defaults to `color`. */
  stderrColor?: boolean;
  mode?: "text" | "json";
  jsonStyle?: RunnerJsonStyle;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  nonInteractive?: boolean;
  onDiagnostics?: RunnerDiagnosticsListener;
  /**
   * A started update check (`startUpdateCheck` from `@clifn/core/update-check`). In text mode its notice is written to
   * stderr after the action finishes, on success or failure, without changing the exit code; a notice that is not
   * ready by the check's timeout is dropped. JSON mode and `quiet` never ask for or write it.
   */
  updateCheck?: Pick<UpdateCheck, "notice">;
}

export interface RunnerContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly output: OutputService;
  readonly diagnostics: RunnerDiagnosticsSink;
  readonly exec: ExecService;
  readonly scaffold: ScaffoldService;
  readonly nonInteractive: boolean;
}

export type RunnerActionResult =
  | void
  | {
      exitCode?: number;
      data?: unknown;
      diagnostics?: readonly Diagnostic[];
    };

interface RunnerFailurePayload {
  code: "CLIFN_RUNNER_FAILED";
  message: string;
}

function normalizeExitCode(exitCode: number | undefined): number {
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0) {
    return 0;
  }
  return exitCode;
}

function normalizeError(error: unknown): RunnerFailurePayload {
  if (error instanceof Error) {
    return {
      code: "CLIFN_RUNNER_FAILED",
      message: error.message || error.name,
    };
  }

  return {
    code: "CLIFN_RUNNER_FAILED",
    message: typeof error === "string" ? error : "Unknown runner failure",
  };
}

export async function runAction<TOptions>(
  action: (options: TOptions, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult,
  options: TOptions,
  runnerOptions: RunnerOptions = {}
): Promise<number> {
  const cwd = runnerOptions.cwd ?? process.cwd();
  const env = runnerOptions.env ?? process.env;
  const diagnostics: Diagnostic[] = [];
  const baseExec = createExec();
  const baseScaffold = createScaffold();
  // The output options are read once each, in the order the output was always created with them, and both the
  // document check and whichever output is created use these values.
  const quiet = runnerOptions.quiet;
  const verbose = runnerOptions.verbose;
  const color = runnerOptions.color;
  const stderrColor = runnerOptions.stderrColor;
  const mode = runnerOptions.mode;
  const stdoutOption = runnerOptions.stdout;
  const stderrOption = runnerOptions.stderr;
  const documentMode = mode === "json" && runnerOptions.jsonStyle === "document";
  const documentStderr = stderrOption ?? ((text: string) => process.stderr.write(text));
  // Streamed child output that has no writer of its own: written to stderr as advice, so a stderr writer that throws
  // loses those chunks but never throws from the child's stream listener, where nothing could catch it.
  const forwardToStderr = (text: string) => {
    try {
      documentStderr(text);
    } catch {
      // The chunk is lost; the run and its result document go on.
    }
  };
  const document = documentMode
    ? createDocumentOutput({
        quiet,
        verbose,
        color,
        stdout: stdoutOption ?? ((text: string) => process.stdout.write(text)),
        stderr: documentStderr,
      })
    : undefined;
  const output =
    document?.service ??
    createOutput({
      quiet,
      verbose,
      color,
      stderrColor,
      mode,
      stdout: stdoutOption,
      stderr: stderrOption,
    });

  // Document mode keeps each diagnostic as the document prints it, within the document's bounds, never the object
  // it was given (see `DocumentDiagnostics`).
  const documentDiagnostics = document?.diagnostics;
  const diagnosticSink: RunnerDiagnosticsSink = documentDiagnostics
    ? {
        add(input: Diagnostic) {
          documentDiagnostics.add(input);
        },
        list() {
          return documentDiagnostics.list();
        },
      }
    : {
        add(input: Diagnostic) {
          diagnostics.push(input);
        },
        list() {
          return diagnostics;
        },
      };

  const ctx: RunnerContext = {
    cwd,
    env,
    output,
    diagnostics: diagnosticSink,
    exec: {
      command(file, args, options) {
        const execOptions = {
          ...options,
          cwd: options?.cwd ?? cwd,
          env: options?.env ?? env,
        };
        if (documentMode && execOptions.streamOutput) {
          // stdout carries only the result document, so streamed child output without its own writer goes to stderr.
          // The options were read once, into the copy.
          execOptions.stdout ??= forwardToStderr;
          execOptions.stderr ??= forwardToStderr;
        }
        return baseExec.command(file, args, execOptions);
      },
    },
    scaffold: {
      apply(operations, options) {
        return baseScaffold.apply(operations, {
          ...options,
          cwd: options?.cwd ?? cwd,
        });
      },
    },
    nonInteractive: runnerOptions.nonInteractive ?? false,
  };

  if (document) {
    return await runDocumentAction(action, options, ctx, runnerOptions, document);
  }

  let exitCode: number;
  try {
    const result = await action(options, ctx);

    for (const diagnostic of result?.diagnostics ?? []) {
      diagnosticSink.add(diagnostic);
    }

    const collectedDiagnostics = diagnosticSink.list();
    runnerOptions.onDiagnostics?.(collectedDiagnostics);

    if (runnerOptions.mode === "json" && result?.data !== undefined) {
      output.json(result.data);
    }

    exitCode = normalizeExitCode(result?.exitCode);
  } catch (error) {
    const failure = normalizeError(error);
    runnerOptions.onDiagnostics?.(diagnosticSink.list());

    if (runnerOptions.mode === "json") {
      output.json({
        ok: false,
        error: failure,
      });
    } else {
      output.error(failure.message);
    }

    exitCode = 1;
  }

  // `mode` and `quiet` as read once above, so the existing option reads stay as they were; only a text-mode run that
  // is not quiet reads `updateCheck`.
  if (mode !== "json" && !quiet) {
    await writeUpdateNotice(runnerOptions, stderrOption);
  }
  return exitCode;
}

/**
 * Writes the update check's notice, if any, as one line on stderr. Advisory: a check, `notice()` or stderr writer that
 * throws or rejects loses only the notice.
 */
async function writeUpdateNotice(
  runnerOptions: RunnerOptions,
  stderrOption: ((text: string) => void) | undefined
): Promise<void> {
  try {
    const updateCheck = runnerOptions.updateCheck;
    if (updateCheck === undefined || updateCheck === null) {
      return;
    }
    const notice = await updateCheck.notice();
    if (typeof notice !== "string" || notice === "") {
      return;
    }
    const stderr = stderrOption ?? ((text: string) => process.stderr.write(text));
    stderr(`${notice}\n`);
  } catch {
    // The notice is lost; the action's output and exit code stand.
  }
}

/**
 * The document-mode run (D8). Only the action's own throw (or rejection) is the run's failure. Reading its result
 * (diagnostics, then data, then exit code, each once) happens afterwards: a result whose members cannot be read, such
 * as one whose getter throws, prints the fixed CLIFN_RUNNER_FAILED document with exit code 1. The returned
 * diagnostics themselves are read entry by entry, and one that cannot be read is dropped with a warning (see
 * `addReturnedDiagnostics`). `onDiagnostics` is called once, after the diagnostics are read, with the diagnostics the
 * document kept, as it prints them (see `DocumentDiagnostics.list`); when it throws after a successful action, its
 * error is the run's failure.
 */
async function runDocumentAction<TOptions>(
  action: (options: TOptions, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult,
  options: TOptions,
  ctx: RunnerContext,
  runnerOptions: RunnerOptions,
  document: DocumentOutput
): Promise<number> {
  let outcome: DocumentOutcome | undefined;
  let result: RunnerActionResult = undefined;
  try {
    result = await action(options, ctx);
  } catch (error) {
    outcome = { ok: false, error };
  }

  let readable = true;
  if (outcome === undefined) {
    let returned: unknown;
    try {
      returned = result?.diagnostics;
    } catch {
      readable = false;
    }
    if (readable) {
      addReturnedDiagnostics(returned, document.diagnostics);
    }
  }

  try {
    runnerOptions.onDiagnostics?.(ctx.diagnostics.list());
  } catch (error) {
    // A failed action keeps its own failure; after a successful one, the listener's failure is the run's.
    outcome ??= readable ? { ok: false, error } : undefined;
  }

  if (outcome === undefined && readable) {
    try {
      const data = result?.data;
      const exitCode = result?.exitCode;
      outcome = { ok: true, data, exitCode: normalizeExitCode(exitCode) };
    } catch {
      readable = false;
    }
  }

  if (!readable || outcome === undefined) {
    return document.failPreparation();
  }
  return document.finish(outcome);
}
