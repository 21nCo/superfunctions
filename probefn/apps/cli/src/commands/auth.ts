import {
  createProbefnError,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { saveAuthProfile } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

export async function runAuthCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  if (args[0] !== 'profile' || args[1] !== 'save') {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Unknown auth command ${args.join(' ') || '<none>'}.`,
      retryable: false,
    });
  }

  const sessionId = requireFlag(args.slice(2), '--session', 'Missing required --session flag.');
  const profileId = requireFlag(args.slice(2), '--profile', 'Missing required --profile flag.');
  const envelope = await saveAuthProfile(context.runtime, {
    sessionId,
    profileId,
  });
  const data = expectSuccess(envelope).data as {
    storageStatePath: string;
  };

  return {
    envelope,
    human: data.storageStatePath,
  };
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
