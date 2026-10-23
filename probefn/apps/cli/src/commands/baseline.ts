import {
  createProbefnError,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { compareVisualBaseline, recordVisualBaseline } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

export async function runBaselineCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  switch (args[0]) {
    case 'record':
      return handleRecord(args.slice(1), context);
    case 'compare':
      return handleCompare(args.slice(1), context);
    default:
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: `Unknown baseline subcommand ${args[0] ?? '<none>'}.`,
        retryable: false,
      });
  }
}

async function handleRecord(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const envelope = await recordVisualBaseline(context.runtime, {
    sessionId: requireFlag(args, '--session', 'Missing required --session flag.'),
    checkpointId: requireFlag(args, '--checkpoint', 'Missing required --checkpoint flag.'),
    key: requireFlag(args, '--key', 'Missing required --key flag.'),
    ...(getFlagValue(args, '--config') ? { configPath: getFlagValue(args, '--config')! } : {}),
  });
  const success = expectSuccess(envelope);
  const data = success.data as {
    baselineKey: string;
  };
  return {
    envelope,
    human: data.baselineKey,
  };
}

async function handleCompare(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const envelope = await compareVisualBaseline(context.runtime, {
    sessionId: requireFlag(args, '--session', 'Missing required --session flag.'),
    checkpointId: requireFlag(args, '--checkpoint', 'Missing required --checkpoint flag.'),
    key: requireFlag(args, '--key', 'Missing required --key flag.'),
    ...(getFlagValue(args, '--config') ? { configPath: getFlagValue(args, '--config')! } : {}),
  });
  const success = expectSuccess(envelope);
  const data = success.data as {
    status: string;
  };
  return {
    envelope,
    human: data.status,
  };
}

function expectSuccess(envelope: ProbefnEnvelope<JsonValue>) {
  if (!envelope.ok) {
    throw createProbefnError({
      code: envelope.error.code as never,
      message: envelope.error.message,
      retryable: envelope.error.retryable,
      ...(envelope.error.details ? { details: envelope.error.details } : {}),
    });
  }

  return envelope;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    return undefined;
  }

  return value;
}

function requireFlag(args: string[], flag: string, message: string): string {
  const value = getFlagValue(args, flag);
  if (!value) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message,
      retryable: false,
    });
  }

  return value;
}
