import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import type { ValidateApiKey } from '../middleware/auth.js';

export interface WsAuthResult {
  ok: boolean;
  botId?: string;
  deferred?: boolean;
}

export async function authenticateWebSocket(
  req: IncomingMessage,
  validateApiKey: ValidateApiKey
): Promise<WsAuthResult> {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');

  const match = url.pathname.match(/^\/ws\/transcripts\/([^/]+)$/);
  if (!match) {
    return { ok: false };
  }
  const botId = match[1];

  if (!token) {
    return { ok: false, botId, deferred: true };
  }

  const result = await validateApiKey(token);
  const ok =
    !!result &&
    (!(typeof result === 'object' && result !== null && 'ok' in result) ||
      Boolean((result as { ok?: boolean }).ok));
  return { ok, botId };
}
