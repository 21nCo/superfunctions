import { parseArgs } from "node:util";
import { runDocumentFixture, runParsedFixture, type ParserFixtureResult } from "../shared.js";

export async function runParseArgsFixture(argv: string[]): Promise<ParserFixtureResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: {
        type: "string",
      },
      quiet: {
        type: "boolean",
      },
      verbose: {
        type: "boolean",
      },
      json: {
        type: "boolean",
      },
      fail: {
        type: "boolean",
      },
      yes: {
        type: "boolean",
      },
    },
  });

  if (positionals[0] === "status") {
    return runDocumentFixture(
      "parseArgs",
      { name: values.name ?? "world", fail: values.fail },
      { json: values.json, quiet: values.quiet, verbose: values.verbose, yes: values.yes }
    );
  }

  if (positionals[0] !== "greet") {
    throw new Error("parseArgs canary expects the greet command.");
  }

  return runParsedFixture("parseArgs", values.name ?? "world", {
    quiet: values.quiet,
    verbose: values.verbose,
    json: values.json,
  });
}
