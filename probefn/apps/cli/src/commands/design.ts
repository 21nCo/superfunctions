import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createProbefnError,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { auditDesign } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

export async function runDesignCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  if (args[0] !== 'design') {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Unknown audit subcommand ${args[0] ?? '<none>'}.`,
      retryable: false,
    });
  }

  const sessionId = requireFlag(args.slice(1), '--session', 'Missing required --session flag.');
  const explicitCheckpointId = getFlagValue(args.slice(1), '--checkpoint');
  const checkpointId = explicitCheckpointId ?? await resolveLatestCheckpointId(context, sessionId);
  const envelope = await auditDesign(context.runtime, {
    sessionId,
    checkpointId,
    ...(getFlagValue(args.slice(1), '--config')
      ? { configPath: getFlagValue(args.slice(1), '--config')! }
      : {}),
  });
  const success = expectSuccess(envelope);
  const data = success.data as {
    findings: unknown[];
  };
  return {
    envelope,
    human: `${data.findings.length}`,
  };
}

async function resolveLatestCheckpointId(
  context: CliCommandContext,
  sessionId: string,
): Promise<string> {
  const { session } = await context.runtime.resolveSessionContext(sessionId);
  const checkpointsRoot = path.resolve(context.repoRoot, session.artifactRoot, 'checkpoints');
  const entries = await readdir(checkpointsRoot, {
    withFileTypes: true,
  });
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        JSON.parse(
          await readFile(path.resolve(checkpointsRoot, entry.name, 'checkpoint.json'), 'utf8'),
        ) as { checkpointId: string; createdAt: string },
      ),
  );
  manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latest = manifests[0];
  if (!latest) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Session ${sessionId} does not have any checkpoints.`,
      retryable: false,
    });
  }

  return latest.checkpointId;
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
