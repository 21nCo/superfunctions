import type { ApiErrorTelemetry } from './observability/error-context.js';
import { createServer } from 'node:http';
import { readBodyText, PayloadTooLargeError } from './api/body.js';
import { error } from './api/envelope.js';

/** Node transport with a bounded body, including requests without Content-Length. */
export function createControlPlaneServer(app: { fetch(request: Request): Response | Promise<Response> }, telemetry?: { recordApiError(event: ApiErrorTelemetry): Promise<void> }) {
  return createServer(async (req, res) => {
    let readingRequest = true;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const method = req.method ?? 'GET';
      let body: string | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const iterator = req.iterator({ destroyOnReturn: false });
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const item = await iterator.next();
            if (item.done) controller.close();
            else controller.enqueue(typeof item.value === 'string' ? Buffer.from(item.value) : item.value);
          },
          async cancel() { await iterator.return?.(); },
        }, { highWaterMark: 0 });
        body = await readBodyText(new Request(url, { method, headers, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }));
      }
      readingRequest = false;
      const response = await app.fetch(new Request(url, { method, headers, body }));
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (cause) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const oversized = cause instanceof PayloadTooLargeError;
      let status = oversized ? 413 : readingRequest ? 400 : 500;
      let code: Parameters<typeof error>[0] = oversized ? 'PAYLOAD_TOO_LARGE' : readingRequest ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
      let message = oversized ? 'Request body exceeds 1048576 bytes' : readingRequest ? 'Invalid request body' : 'Internal server error';
      if (telemetry) {
        const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method ?? '') ? req.method! : 'OTHER';
        try { await telemetry.recordApiError({ code, route: 'unmatched', method, status }); }
        catch { status = 503; code = 'UNAVAILABLE'; message = 'Required error telemetry could not be persisted'; }
      }
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(error(code, message)));
    }
  });
}
