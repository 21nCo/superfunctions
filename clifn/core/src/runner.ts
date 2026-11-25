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
 * message as a JSON line to stderr. It has no effect in text mode.
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

  const diagnosticSink: RunnerDiagnosticsSink = {
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
    return await runDocumentAction(action, options, ctx, runnerOptions, document);
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

async function runDocumentAction<TOptions>(
  action: (options: TOptions, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult,
  options: TOptions,
  ctx: RunnerContext,
  runnerOptions: RunnerOptions,
  document: DocumentOutput
): Promise<number> {
  let outcome: DocumentOutcome;

  try {
    const result = await action(options, ctx);

    for (const diagnostic of result?.diagnostics ?? []) {
      ctx.diagnostics.add(diagnostic);
    }

    runnerOptions.onDiagnostics?.(ctx.diagnostics.list());
    outcome = { ok: true, data: result?.data, exitCode: normalizeExitCode(result?.exitCode) };
  } catch (error) {
    try {
      runnerOptions.onDiagnostics?.(ctx.diagnostics.list());
    } catch {
      // The document reports the action's failure; a failing listener does not replace it or suppress the document.
    }
    outcome = { ok: false, error };
  }

  return document.finish(outcome, ctx.diagnostics.list());
}
