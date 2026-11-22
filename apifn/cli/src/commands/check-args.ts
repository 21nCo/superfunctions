/**
 * The `apifn check` grammar, read from the raw argv. cac drops extra positionals and arguments
 * after `--`, accepts `--flag=value` on boolean flags and turns number-looking values into
 * numbers (`1.10` -> 1.1, `0123` -> 123), so `check` reads its arguments here and rejects
 * anything outside this grammar as a usage error (exit 2):
 *
 *   apifn [global options] check [routerPath] [--spec <path>] [--base <ref> | --base-spec <pathOrUrl>]
 *     [--allow-breaking] [--write] [--format <type>] [--report <path>]
 */

export class CheckArgsError extends Error {}

export interface CheckArgs {
  routerPath?: string;
  specPath?: string;
  base?: string;
  baseSpec?: string;
  format?: string;
  reportPath?: string;
  /** The global --config, read literally too. */
  configPath?: string;
  allowBreaking: boolean;
  write: boolean;
}

type ValueField = "specPath" | "base" | "baseSpec" | "format" | "reportPath" | "configPath";

/** Options that take one value. */
const VALUE_OPTIONS: Record<string, ValueField> = {
  spec: "specPath",
  base: "base",
  "base-spec": "baseSpec",
  format: "format",
  report: "reportPath",
  config: "configPath",
};

/** Flags that take no value; null marks a global flag the check itself does not read. */
const FLAGS: Record<string, "allowBreaking" | "write" | null> = {
  "allow-breaking": "allowBreaking",
  write: "write",
  verbose: null,
  quiet: null,
  "no-color": null,
  help: null,
  version: null,
};

const SHORT_FLAGS = new Set(["-h", "-v"]);

/** cac accepts `--baseSpec` for `--base-spec`; compare names in kebab case. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Reads one `--name[=value]` token (and its separate value) into `args`; returns tokens consumed. */
function readLongOption(argv: string[], i: number, args: CheckArgs, given: Set<string>): number {
  const token = argv[i];
  const eq = token.indexOf("=");
  const name = kebab(eq === -1 ? token.slice(2) : token.slice(2, eq));
  if (Object.hasOwn(VALUE_OPTIONS, name)) {
    const next = argv[i + 1];
    const separate = eq === -1 && next !== undefined && !next.startsWith("-");
    let value: string | undefined;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else if (separate) {
      value = next;
    }
    if (value === undefined || value === "" || given.has(name)) {
      throw new CheckArgsError(`--${name} takes one value`);
    }
    given.add(name);
    args[VALUE_OPTIONS[name]] = value;
    return separate ? 2 : 1;
  }
  if (!Object.hasOwn(FLAGS, name)) {
    throw new CheckArgsError(`Unknown option \`${token}\``);
  }
  if (eq !== -1) {
    throw new CheckArgsError(`--${name} takes no value`);
  }
  // `--write false` would otherwise read `false` as the router; `./false` still names one.
  const next = argv[i + 1];
  if (next === "true" || next === "false") {
    throw new CheckArgsError(`--${name} takes no value, got '${next}'; to name a router '${next}', pass ./${next}`);
  }
  const field = FLAGS[name];
  if (field) args[field] = true;
  return 1;
}

/** Parses `argv` (the arguments after the program name, command name included). */
export function parseCheckArgv(argv: string[]): CheckArgs {
  const args: CheckArgs = { allowBreaking: false, write: false };
  const given = new Set<string>();
  const positionals: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--") {
      throw new CheckArgsError("apifn check takes no arguments after '--'; pass the router as [routerPath].");
    }
    if (token.startsWith("--")) {
      i += readLongOption(argv, i, args, given);
      continue;
    }
    if (token.startsWith("-") && token !== "-" && !SHORT_FLAGS.has(token)) {
      throw new CheckArgsError(`Unknown option \`${token}\``);
    }
    if (!token.startsWith("-") || token === "-") positionals.push(token);
    i += 1;
  }

  // The first positional is the command name cac matched.
  const operands = positionals.slice(1);
  if (operands.length > 1) {
    throw new CheckArgsError(
      `apifn check takes at most one [routerPath], got ${operands.length}: ${operands.join(" ")}. Pass a git ref with --base.`
    );
  }
  args.routerPath = operands[0];
  return args;
}

/**
 * True when `argv` runs `apifn check`: its first positional (global options and their values
 * skipped) is `check`. The check reads its arguments before cac does, so a malformed check
 * invocation is a usage error (exit 2) even when it also asks for help.
 */
export function isCheckInvocation(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") return false;
    if (!token.startsWith("-") || token === "-") return token === "check";
    const name = kebab(token.slice(2));
    if (token.startsWith("--") && !token.includes("=") && Object.hasOwn(VALUE_OPTIONS, name)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
    }
  }
  return false;
}
