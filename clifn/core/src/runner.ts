import type { Diagnostic } from "./diagnostics.js";
import { createDocumentOutput, type DocumentOutcome, type DocumentOutput } from "./document-output.js";
import { createExec, type ExecService } from "./exec.js";
import { createOutput, type OutputService } from "./output.js";
import { createScaffold, type ScaffoldService } from "./scaffold.js";

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
 * `"[REDACTED]"`; messages print as given. It has no effect in text mode.
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
  const documentMode = runnerOptions.mode === "json" && runnerOptions.jsonStyle === "document";
  const documentStderr = runnerOptions.stderr ?? ((text: string) => process.stderr.write(text));
  const document = documentMode
    ? createDocumentOutput({
        quiet: runnerOptions.quiet,
        verbose: runnerOptions.verbose,
        color: runnerOptions.color,
        stdout: runnerOptions.stdout ?? ((text: string) => process.stdout.write(text)),
        stderr: documentStderr,
      })
    : undefined;
  const output =
    document?.service ??
    createOutput({
      quiet: runnerOptions.quiet,
      verbose: runnerOptions.verbose,
      color: runnerOptions.color,
      stderrColor: runnerOptions.stderrColor,
      mode: runnerOptions.mode,
      stdout: runnerOptions.stdout,
      stderr: runnerOptions.stderr,
    });

  // A result document prints at most `maxDiagnostics`, so document mode keeps no more and records that it dropped some.
  const maxDiagnostics = document?.maxDiagnostics ?? Number.POSITIVE_INFINITY;
  let droppedDiagnostics = false;
  const diagnosticSink: RunnerDiagnosticsSink = {
    add(input: Diagnostic) {
      if (diagnostics.length < maxDiagnostics) {
        diagnostics.push(input);
      } else {
        droppedDiagnostics = true;
      }
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
        if (documentMode && options?.streamOutput) {
          // stdout carries only the result document, so streamed child output without its own writer goes to stderr.
          execOptions.stdout = options.stdout ?? documentStderr;
          execOptions.stderr = options.stderr ?? documentStderr;
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
    return await runDocumentAction(action, options, ctx, runnerOptions, document, () => droppedDiagnostics);
  }

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

    return normalizeExitCode(result?.exitCode);
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

    return 1;
  }
}

/** ToLength of an array's length, read once: unary plus is ToNumber, so a bigint or symbol throws. */
function toLength(value: unknown): number {
  const number = +(value as number);
  if (Number.isNaN(number) || number <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

/**
 * Adds the diagnostics an action returned, reading at most what the sink can keep: an array's length is read once and
 * only the indices below `room` are read, and an iterable stops at `room` items, so an oversized, sparse or proxied
 * array, or an endless iterable, is cut before its excess is read. Throws what reading them throws.
 */
function addReturnedDiagnostics(returned: unknown, sink: RunnerDiagnosticsSink, room: number, onDrop: () => void): void {
  if (returned === undefined || returned === null) {
    return;
  }
  if (Array.isArray(returned)) {
    const length = toLength(Reflect.get(returned, "length"));
    const count = Math.min(length, room);
    for (let index = 0; index < count; index += 1) {
      sink.add(Reflect.get(returned, String(index)) as Diagnostic);
    }
    if (length > count) {
      onDrop();
    }
    return;
  }
  let count = 0;
  for (const diagnostic of returned as Iterable<Diagnostic>) {
    if (count === room) {
      onDrop();
      break;
    }
    sink.add(diagnostic);
    count += 1;
  }
}

/**
 * The document-mode run (D8). Only the action's own throw (or rejection) is the run's failure. Reading its result
 * (diagnostics, then data, then exit code, each once) happens afterwards: a result that cannot be read, such as one
 * whose getter throws, prints the fixed CLIFN_RUNNER_FAILED document with exit code 1. `onDiagnostics` is called once,
 * after the diagnostics are read; when it throws after a successful action, its error is the run's failure.
 */
async function runDocumentAction<TOptions>(
  action: (options: TOptions, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult,
  options: TOptions,
  ctx: RunnerContext,
  runnerOptions: RunnerOptions,
  document: DocumentOutput,
  droppedDiagnostics: () => boolean
): Promise<number> {
  let outcome: DocumentOutcome | undefined;
  let result: RunnerActionResult = undefined;
  try {
    result = await action(options, ctx);
  } catch (error) {
    outcome = { ok: false, error };
  }

  let readable = true;
  let dropped = false;
  if (outcome === undefined) {
    try {
      const room = Math.max(0, document.maxDiagnostics - ctx.diagnostics.list().length);
      addReturnedDiagnostics(result?.diagnostics, ctx.diagnostics, room, () => {
        dropped = true;
      });
    } catch {
      readable = false;
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
  return document.finish(outcome, ctx.diagnostics.list(), dropped || droppedDiagnostics());
}
