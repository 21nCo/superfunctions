import type { RunnerOptions } from "./runner.js";

/** The part of a stream the terminal rules read. */
export interface TerminalStream {
  readonly isTTY?: boolean;
}

export interface TerminalStreams {
  stdin?: TerminalStream;
  stdout?: TerminalStream;
  stderr?: TerminalStream;
}

export interface ResolveTerminalOptions extends TerminalStreams {
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** JSON output is never interactive. */
  json?: boolean;
}

export interface TerminalState {
  color: boolean;
  interactive: boolean;
  ci: boolean;
}

function isTty(stream: TerminalStream | undefined): boolean {
  return stream?.isTTY === true;
}

/** The colour the environment sets (`NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`), or undefined when it leaves it to the streams. */
function colorFromEnv(env: Readonly<Record<string, string | undefined>>): boolean | undefined {
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") {
    return false;
  }

  const forceColor = env.FORCE_COLOR;
  if (forceColor === "0" || forceColor === "false") {
    return false;
  }
  if (forceColor === "1" || forceColor === "2" || forceColor === "3" || forceColor === "true") {
    return true;
  }

  if (env.TERM === "dumb") {
    return false;
  }

  return undefined;
}

function resolveColor(env: Readonly<Record<string, string | undefined>>, stderr: TerminalStream | undefined): boolean {
  // Logs, prompts and spinners go to stderr, so colour follows stderr rather than stdout.
  return colorFromEnv(env) ?? isTty(stderr);
}

function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/**
 * The terminal rules (D9), as one closed rule set:
 * - colour: a non-empty `NO_COLOR` disables it; `FORCE_COLOR` `0`/`false` disables and `1`/`2`/`3`/`true` enables
 *   it (other values are ignored); `TERM=dumb` disables it; otherwise it follows whether stderr is a TTY;
 * - `ci`: `CI` is set to anything but empty, `0` or `false`;
 * - `interactive`: stdin and stderr are TTYs, not `ci`, and `json` is off.
 * `stdout` is accepted for symmetry and does not change the result.
 */
export function resolveTerminal(options: ResolveTerminalOptions = {}): TerminalState {
  const env = options.env ?? process.env;
  const stdin = "stdin" in options ? options.stdin : process.stdin;
  const stderr = "stderr" in options ? options.stderr : process.stderr;
  const ci = isCi(env);

  return {
    color: resolveColor(env, stderr),
    interactive: isTty(stdin) && isTty(stderr) && !ci && options.json !== true,
    ci,
  };
}

/** Global flags as a parser gives them; only `true` (and `false` for `color`) count, anything else is unset. */
export interface RunnerFlags {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /**
   * `true` or `false` overrides the terminal rules, `'auto'` or unset uses them. commander and cac give a lone
   * `--no-color` option a default of `true`; pass `color: opts.color === false ? false : "auto"` in that case.
   */
  color?: boolean | "auto";
  yes?: boolean;
  nonInteractive?: boolean;
}

export interface ResolveRunnerOptionsContext {
  env?: Readonly<Record<string, string | undefined>>;
  streams?: TerminalStreams;
}

export type ResolvedRunnerOptions = Required<
  Pick<RunnerOptions, "mode" | "color" | "stderrColor" | "quiet" | "verbose" | "nonInteractive">
> &
  Pick<RunnerOptions, "jsonStyle">;

/**
 * Turns parsed global flags and the terminal rules (D9) into runner options: `--json` selects `mode: 'json'` with
 * `jsonStyle: 'document'`, `--yes`/`--non-interactive` or a non-interactive terminal sets `nonInteractive`, and
 * `--color`/`--no-color` override the colour rules. Colour is set per stream: `stderrColor` (errors and the spinner)
 * follows the rules, while `color` (text-mode `debug`, `info`, `success` and `warn` on stdout) also needs stdout to be
 * a TTY, so a piped stdout never gets ANSI escapes unless `--color` or `FORCE_COLOR` asks for them while a terminal
 * stderr keeps its colour. Parser-agnostic: pass the flags your parser produced.
 */
export function resolveRunnerOptions(
  flags: RunnerFlags = {},
  context: ResolveRunnerOptionsContext = {}
): ResolvedRunnerOptions {
  const json = flags.json === true;
  const streams = context.streams ?? {};
  const terminal = resolveTerminal({
    env: context.env,
    json,
    ...("stdin" in streams ? { stdin: streams.stdin } : {}),
    ...("stdout" in streams ? { stdout: streams.stdout } : {}),
    ...("stderr" in streams ? { stderr: streams.stderr } : {}),
  });
  const stdout = "stdout" in streams ? streams.stdout : process.stdout;
  const env = context.env ?? process.env;
  let color = terminal.color;
  let stderrColor = terminal.color;
  if (flags.color === true || flags.color === false) {
    color = flags.color;
    stderrColor = flags.color;
  } else if (!json && colorFromEnv(env) === undefined) {
    color = terminal.color && isTty(stdout);
  }

  return {
    mode: json ? "json" : "text",
    ...(json ? { jsonStyle: "document" as const } : {}),
    color,
    stderrColor,
    quiet: flags.quiet === true,
    verbose: flags.verbose === true,
    nonInteractive: flags.yes === true || flags.nonInteractive === true || !terminal.interactive,
  };
}
