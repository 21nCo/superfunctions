import {
  createProbefnError,
} from '@probefn/contracts';
import { runFlow } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

export async function runFlowCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  if (args[0] !== 'flow') {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Unknown run subcommand ${args[0] ?? '<none>'}.`,
      retryable: false,
    });
  }

  const sessionId = requireFlag(args.slice(1), '--session', 'Missing required --session flag.');
  const file = requireFlag(args.slice(1), '--file', 'Missing required --file flag.');
  const envelope = await runFlow(context.runtime, {
    sessionId,
    file,
  });

  return {
    envelope,
    human: file,
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
