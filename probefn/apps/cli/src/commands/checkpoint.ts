import {
  createSuccessEnvelope,
  createProbefnError,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { createCheckpointFromSession } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

export async function runCheckpointCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  if (args[0] !== 'create') {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Unknown checkpoint subcommand ${args[0] ?? '<none>'}.`,
      retryable: false,
    });
  }

  const sessionId = requireFlag(args, '--session', 'Missing required --session flag.');
  const name = requireFlag(args, '--name', 'Missing required --name flag.');
  const includeVideo = args.includes('--include-video');
  const envelope = await createCheckpointFromSession(context.runtime, {
    sessionId,
    name,
    ...(args.includes('--include-trace') ? { includeTrace: true } : {}),
    ...(args.includes('--include-styles') ? { includeStyles: true } : {}),
  });
  const success = expectSuccess(envelope);
  const warnings = includeVideo
    ? [...success.warnings, 'Video capture is not implemented in this phase.']
    : success.warnings;
  const finalEnvelope = createSuccessEnvelope(success.data, warnings);
  const data = success.data as {
    checkpointId: string;
  };

  return {
    envelope: finalEnvelope,
    human: data.checkpointId,
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
