import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DesignTokenTheme } from './schema';
import { generateSwiftTokens, type SwiftThemeSet } from './swift';

const USAGE = `Usage: uifn-swift-tokens --name <identifier> --light <theme.json> --out <file.swift>
  [--dark <theme.json>] [--high-contrast-light <theme.json>] [--high-contrast-dark <theme.json>]
  [--import <Module>]... [--access public|internal] [--check]

Writes one Swift source file declaring UIFnTheme.<identifier>. With --check,
exits 1 instead of writing when the file differs from the generated output.`;

export interface SwiftCliIo {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const nodeIo: SwiftCliIo = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, contents) => writeFileSync(path, contents),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function readTheme(io: SwiftCliIo, path: string | undefined): DesignTokenTheme | undefined {
  if (path === undefined) return undefined;
  return JSON.parse(io.readFile(path)) as DesignTokenTheme;
}

function readExisting(io: SwiftCliIo, path: string): string | undefined {
  try {
    return io.readFile(path);
  } catch {
    return undefined;
  }
}

/** Runs the CLI and returns its exit code. */
export function runSwiftTokensCli(argv: string[], io: SwiftCliIo = nodeIo): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        name: { type: 'string' },
        light: { type: 'string' },
        dark: { type: 'string' },
        'high-contrast-light': { type: 'string' },
        'high-contrast-dark': { type: 'string' },
        out: { type: 'string' },
        import: { type: 'string', multiple: true },
        access: { type: 'string' },
        check: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (!values.name || !values.light || !values.out) {
    io.stderr(`--name, --light and --out are required.\n\n${USAGE}`);
    return 2;
  }
  if (values.access !== undefined && values.access !== 'public' && values.access !== 'internal') {
    io.stderr(`--access must be public or internal.\n\n${USAGE}`);
    return 2;
  }

  let output: string;
  try {
    const themes: SwiftThemeSet = {
      light: readTheme(io, values.light)!,
      dark: readTheme(io, values.dark),
      highContrastLight: readTheme(io, values['high-contrast-light']),
      highContrastDark: readTheme(io, values['high-contrast-dark']),
    };
    output = generateSwiftTokens(themes, {
      name: values.name,
      access: values.access as 'public' | 'internal' | undefined,
      imports: values.import,
    });
  } catch (error) {
    const details = (error as { details?: unknown }).details;
    io.stderr(`${(error as Error).message}${details ? ` ${JSON.stringify(details)}` : ''}`);
    return 1;
  }

  if (values.check) {
    if (readExisting(io, values.out) !== output) {
      io.stderr(`${values.out} is out of date; rerun without --check to regenerate it.`);
      return 1;
    }
    io.stdout(`${values.out} is up to date.`);
    return 0;
  }

  io.writeFile(values.out, output);
  io.stdout(`Wrote ${values.out}.`);
  return 0;
}
