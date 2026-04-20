import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createProbefnError,
  toErrorEnvelope,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { runMcpCli, ProbefnRuntime } from '@probefn/mcp-server';

import { runAuthCommand } from './commands/auth.js';
import { runBaselineCommand } from './commands/baseline.js';
import { runCheckpointCommand } from './commands/checkpoint.js';
import { runDesignCommand } from './commands/design.js';
import { runPageCommand } from './commands/page.js';
import { runReportCommand } from './commands/report.js';
import { runFlowCommand } from './commands/flow.js';
import { runSessionCommand } from './commands/session.js';
import { writeJsonEnvelope } from './output/json.js';
import { formatHumanError, writeHumanOutput } from './output/human.js';

export const CLI_PACKAGE_NAME = '@probefn/cli';

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface CliCommandContext {
  repoRoot: string;
  runtime: ProbefnRuntime;
}

export interface CliCommandResult {
  envelope: ProbefnEnvelope<JsonValue>;
  human: string;
}

export async function executeCli(
  args: string[] = process.argv.slice(2),
  options: {
    repoRoot?: string;
    io?: CliIo;
  } = {},
): Promise<number> {
  const repoRoot =
    options.repoRoot ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const runtime = new ProbefnRuntime(repoRoot);
  const json = args.includes('--json');

  try {
    if (args[0] === 'mcp') {
      await runMcpCli(args.slice(1));
      return 0;
    }

    const context: CliCommandContext = {
      repoRoot,
      runtime,
    };

    let result: CliCommandResult;
    switch (args[0]) {
      case 'session':
        result = await runSessionCommand(args.slice(1), context);
        break;
      case 'page':
        result = await runPageCommand(args.slice(1), context);
        break;
      case 'checkpoint':
        result = await runCheckpointCommand(args.slice(1), context);
        break;
      case 'audit':
        result = await runDesignCommand(args.slice(1), context);
        break;
      case 'baseline':
        result = await runBaselineCommand(args.slice(1), context);
        break;
      case 'report':
        result = await runReportCommand(args.slice(1), context);
        break;
      case 'auth':
        result = await runAuthCommand(args.slice(1), context);
        break;
      case 'run':
        result = await runFlowCommand(args.slice(1), context);
        break;
      default:
        throw createProbefnError({
          code: 'E_CONFIG_INVALID',
          message: `Unknown CLI command ${args[0] ?? '<none>'}.`,
          retryable: false,
        });
    }

    if (json) {
      const target = result.envelope.ok ? io.stdout : io.stderr;
      await writeJsonEnvelope(target, result.envelope);
    } else if (result.envelope.ok) {
      await writeHumanOutput(io.stdout, result.human);
    } else {
      await writeHumanOutput(io.stderr, formatHumanError(result.envelope));
    }

    return result.envelope.ok ? 0 : mapExitCode(result.envelope);
  } catch (error) {
    const envelope = toErrorEnvelope(error) as ProbefnEnvelope<JsonValue>;
    if (json) {
      await writeJsonEnvelope(io.stderr, envelope);
    } else {
      await writeHumanOutput(io.stderr, formatHumanError(envelope));
    }
    return mapExitCode(envelope);
  }
}

function mapExitCode(envelope: ProbefnEnvelope<JsonValue>): number {
  if (envelope.ok) {
    return 0;
  }

  switch (envelope.error.code) {
    case 'E_CONFIG_INVALID':
    case 'E_MCP_INVALID_ARGS':
      return 2;
    case 'E_SESSION_NOT_FOUND':
    case 'E_AUTH_PROFILE_NOT_FOUND':
    case 'E_ACTION_TARGET_NOT_FOUND':
    case 'E_ACTION_AMBIGUOUS':
    case 'E_ACTION_NOT_INTERACTABLE':
    case 'E_BASELINE_NOT_FOUND':
      return 3;
    default:
      return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await executeCli();
  process.exit(exitCode);
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown CLI error.';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
