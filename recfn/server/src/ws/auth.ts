import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { Logger } from '../integrations/logfn.js';

export type VerifyBotAccess = (
  botId: string,
  namespace: string,
) => Promise<boolean> | boolean;

export type WsAuthFailureCode = 'UNAUTHORIZED' | 'WS_NAMESPACE_FORBIDDEN';

export interface WsAuthResult {
  ok: boolean;
  botId?: string;
  namespace?: string;
  deferred?: boolean;
  code?: WsAuthFailureCode;
  httpStatus?: 400 | 401 | 403;
}

function logWsAuthFailure(
  logger: Logger | undefined,
  event: string,
  data: Record<string, unknown>,
): void {
  logger?.warn(event, data);
}

function getTranscriptBotId(req: IncomingMessage): string | undefined {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const match = url.pathname.match(/^\/ws\/transcripts\/([^/]+)$/);
  return match?.[1];
}

export async function authorizeTranscriptSubscription(
  botId: string,
  token: string,
  validateApiKey: ValidateApiKey,
  verifyBotAccess: VerifyBotAccess,
  logger?: Logger,
): Promise<WsAuthResult> {
  const auth = await validateApiKey(token);
  if (!auth) {
    logWsAuthFailure(logger, 'ws.auth.failed', {
      botId,
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    });
    return {
      ok: false,
      botId,
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    };
  }

  const allowed = await verifyBotAccess(botId, auth.namespace);
  if (!allowed) {
    logWsAuthFailure(logger, 'ws.auth.failed', {
      botId,
      namespace: auth.namespace,
      code: 'WS_NAMESPACE_FORBIDDEN',
      httpStatus: 403,
    });
    return {
      ok: false,
      botId,
      code: 'WS_NAMESPACE_FORBIDDEN',
      httpStatus: 403,
    };
  }

  return {
    ok: true,
    botId,
    namespace: auth.namespace,
  };
}

export async function authenticateWebSocket(
  req: IncomingMessage,
  validateApiKey: ValidateApiKey,
  verifyBotAccess: VerifyBotAccess,
  logger?: Logger,
): Promise<WsAuthResult> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const botId = getTranscriptBotId(req);
  if (!botId) {
    logWsAuthFailure(logger, 'ws.auth.failed', {
      code: 'BAD_REQUEST',
      httpStatus: 400,
    });
    return { ok: false, httpStatus: 400 };
  }

  if (!token) {
    logger?.info('ws.auth.deferred', { botId });
    return { ok: false, botId, deferred: true };
  }

  return authorizeTranscriptSubscription(botId, token, validateApiKey, verifyBotAccess, logger);
}
