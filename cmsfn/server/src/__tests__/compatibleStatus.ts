/** Explicit status contract for operation fixtures; capability failures have their own tests. */
import type { IncomingMessage, ServerResponse } from 'node:http';
export const compatibleStatus = { ok: true, result: { serverTime: '2026-10-23T00:00:00.000Z', capabilities: ['content.schema', 'content.docs', 'content.assets', 'content.audit', 'content.webhooks', 'content.realtime'] } };
export function serveCompatibleStatus(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url !== '/contentfn/status') return false;
  req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(compatibleStatus)); return true;
}
