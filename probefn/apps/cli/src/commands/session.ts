import {
  createSuccessEnvelope,
  createProbefnError,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import { startSessionFromConfig, stopSession } from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

const DEFAULT_DETERMINISTIC = {
  enabled: true,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light' as const,
  reducedMotion: 'reduce' as const,
  animationPolicy: 'freeze' as const,
  networkIdleMs: 500,
};

export async function runSessionCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  switch (args[0]) {
    case 'start':
      return handleStart(args.slice(1), context);
    case 'stop':
      return handleStop(args.slice(1), context);
    default:
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: `Unknown session subcommand ${args[0] ?? '<none>'}.`,
        retryable: false,
      });
  }
}

async function handleStart(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const configPath = getFlagValue(args, '--config');
  const url = getFlagValue(args, '--url');
  const devServerName = getFlagValue(args, '--dev-server');
  const mode = getFlagValue(args, '--mode');
  const browser = getFlagValue(args, '--browser');
  const authProfileId = getFlagValue(args, '--auth-profile') ?? getFlagValue(args, '--auth-profile-id');

  const envelope =
    configPath
      ? await startSessionFromConfig(context.runtime, {
          configPath,
          ...(mode ? { mode: mode as never } : {}),
          ...(browser ? { browser: browser as never } : {}),
          ...(devServerName ? { devServerName } : {}),
          ...(url ? { url } : {}),
          ...(authProfileId ? { authProfileId } : {}),
        })
      : await startAdhocAttachSession(args, context);

  const data = expectSuccess(envelope).data as {
    sessionId: string;
    runId: string;
    resolvedUrl: string;
  };
  return {
    envelope,
    human: `session=${data.sessionId} run=${data.runId} url=${data.resolvedUrl}`,
  };
}

async function startAdhocAttachSession(
  args: string[],
  context: CliCommandContext,
): Promise<ProbefnEnvelope<JsonValue>> {
  const url = getFlagValue(args, '--url');
  if (!url) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Session start requires either --config or --url.',
      retryable: false,
    });
  }

  const mode = (getFlagValue(args, '--mode') ?? 'debug') as 'debug' | 'design-review' | 'visual-regression' | 'mixed';
  const browser = (getFlagValue(args, '--browser') ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';
  const sessionId = `sess_${Date.now()}`;
  const runId = `run_${Date.now()}`;
  const scope = context.runtime.createScope('.artifacts');
  const startedSession = await scope.devServerManager.startSession({
    sessionId,
    runId,
    mode,
    browser,
    deterministic: DEFAULT_DETERMINISTIC,
    devServer: {
      mode: 'attach',
      name: getFlagValue(args, '--dev-server') ?? 'adhoc',
      url,
      timeoutMs: 120000,
      envAllowlist: [],
    },
  });

  await scope.sessionManager.initialize({
    sessionId,
    runId,
    mode,
    browser,
    deterministic: DEFAULT_DETERMINISTIC,
    artifactRoot: startedSession.artifactRoot,
    startedAt: startedSession.startedAt,
    manifestPath: startedSession.manifestPath,
    resolvedUrl: startedSession.resolvedUrl,
  });
  await scope.sessionManager.markRunning(sessionId, {
    resolvedUrl: startedSession.resolvedUrl,
  });
  context.runtime.rememberSession(sessionId, '.artifacts');

  return createSuccessEnvelope({
    sessionId,
    runId,
    artifactRoot: startedSession.artifactRoot,
    startedAt: startedSession.startedAt,
    resolvedUrl: startedSession.resolvedUrl,
  });
}

async function handleStop(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const sessionId = requireFlag(args, '--session', 'Missing required --session flag.');
  const envelope = await stopSession(context.runtime, sessionId);
  const data = expectSuccess(envelope).data as {
    sessionId: string;
    status: string;
  };
  return {
    envelope,
    human: `session=${data.sessionId} status=${data.status}`,
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
