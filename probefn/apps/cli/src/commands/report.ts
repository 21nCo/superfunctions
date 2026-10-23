import {
  createProbefnError,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { exportSessionReport } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

export async function runReportCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  if (args[0] !== 'export') {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Unknown report subcommand ${args[0] ?? '<none>'}.`,
      retryable: false,
    });
  }

  const format = parseReportFormat(getFlagValue(args.slice(1), '--format') ?? 'json');
  const envelope = await exportSessionReport(context.runtime, {
    sessionId: requireFlag(args.slice(1), '--session', 'Missing required --session flag.'),
    format,
  });
  const success = expectSuccess(envelope);
  const data = success.data as {
    reportPath: string;
  };
  return {
    envelope,
    human: data.reportPath,
  };
}

function parseReportFormat(value: string): 'json' | 'markdown' {
  if (value === 'json' || value === 'markdown') {
    return value;
  }

  throw createProbefnError({
    code: 'E_CONFIG_INVALID',
    message: `Unsupported report format ${value}. Expected json or markdown.`,
    retryable: false,
  });
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
