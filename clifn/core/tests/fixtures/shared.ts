import { runAction } from "../../src/runner.js";
import { resolveRunnerOptions, type RunnerFlags } from "../../src/terminal.js";

export interface ParserFixtureGlobals {
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
}

export interface ParserFixtureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runParsedFixture(
  parser: "commander" | "cac" | "parseArgs",
  name: string,
  globals: ParserFixtureGlobals = {}
): Promise<ParserFixtureResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runAction(
    async (options: { name: string }, ctx) => {
      ctx.output.debug(`parser ${parser}`);

      if (globals.json) {
        return {
          data: {
            ok: true,
            parser,
            name: options.name,
          },
        };
      }

      ctx.output.info(`hello ${options.name} from ${parser}`);
      return undefined;
    },
    { name },
    {
      cwd: "repo root",
      nonInteractive: true,
      color: false,
      quiet: globals.quiet,
      verbose: globals.verbose,
      mode: globals.json ? "json" : "text",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }
  );

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

export interface DocumentFixtureInput {
  name: string;
  fail?: boolean;
}

/**
 * A document-mode command: the parser's global flags go through `resolveRunnerOptions`, as a CLI author would wire
 * them. The terminal is a pipe with no environment, so the result does not depend on where the tests run.
 */
export async function runDocumentFixture(
  parser: "commander" | "cac" | "parseArgs",
  input: DocumentFixtureInput,
  flags: RunnerFlags
): Promise<ParserFixtureResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pipe = { isTTY: false };

  const exitCode = await runAction(
    (options: DocumentFixtureInput, ctx) => {
      ctx.output.info(`status for ${options.name} from ${parser}`);
      if (options.fail) {
        throw Object.assign(new Error(`${options.name} is unavailable`), { code: "STATUS_UNAVAILABLE", exitCode: 3 });
      }
      return { data: { parser, name: options.name, nonInteractive: ctx.nonInteractive } };
    },
    input,
    {
      ...resolveRunnerOptions(flags, { env: {}, streams: { stdin: pipe, stdout: pipe, stderr: pipe } }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }
  );

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}
