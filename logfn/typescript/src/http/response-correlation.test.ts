import { expect, it } from 'vitest';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { createRouter } from '@superfunctions/http';
import { Logger } from '../core/logger.js';
import type { LogEvent } from '../types.js';
import { requestLogger as expressLogger } from './express.js';
import { requestLogger as fastifyLogger } from './fastify.js';
import { requestLogger as honoLogger } from './hono.js';
import { requestLogger as sharedLogger } from './shared.js';

const trace = '0af7651916cd43dd8448eb211c80319c';
const span = 'b7ad6b7169203331';
for (const framework of ['express', 'fastify', 'hono', 'shared'] as const) {
  for (const failing of [false, true]) {
    for (const sampled of [false, true]) {
      it(`${framework} correlates ${failing ? 'error' : 'success'} responses with sampling ${sampled}`, async () => {
        const events: LogEvent[] = [];
        const logger = new Logger({ name: 'response', sinks: [batch => { events.push(...batch); }] });
        const options = { logger, sample: sampled ? 1 : 0 };
        const incoming = { traceparent: sampled ? `00-${trace}-${span}-01` : 'invalid-private-value', 'x-request-id': 'untrusted-request' };
        let response: Response;
        if (framework === 'express') {
          const app = express(); app.use(expressLogger(options));
          app.get('/', (req, res) => { (req as any).log.info('application'); if (failing) throw new Error('private'); res.send('ok'); });
          app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(503).send('failed'); });
          const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
          try { response = await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}`, { headers: incoming }); await response.text(); }
          finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        } else if (framework === 'fastify') {
          const app = Fastify(); app.register(fastifyLogger(options));
          app.get('/', request => { expect(typeof request.log.child).toBe('function'); request.logfn!.info('application'); if (failing) throw new Error('private'); return 'ok'; });
          app.setErrorHandler((_error, _req, reply) => reply.status(503).send('failed'));
          try { const result = await app.inject({ url: '/', headers: incoming }); response = new Response(result.body, { status: result.statusCode, headers: result.headers as Record<string,string> }); }
          finally { await app.close(); }
        } else if (framework === 'hono') {
          const app = new Hono(); app.use(honoLogger(options));
          app.get('/', c => { c.get('log').info('application'); if (failing) throw new Error('private'); return c.text('ok'); });
          app.onError((_error, c) => c.text('failed', 503)); response = await app.request('/', { headers: incoming });
        } else {
          const router = createRouter({ middleware: [sharedLogger(options)], onError: () => new Response('failed', { status: 503 }), routes: [{ method: 'GET', path: '/', handler: (_req, ctx) => { (ctx as any).log.info('application'); if (failing) throw new Error('private'); return new Response('ok'); } }] });
          response = await router.handle(new Request('http://local/', { headers: incoming }));
        }
        expect(response.status).toBe(failing ? 503 : 200);
        expect(response.headers.get('x-trace-id')).toMatch(/^[a-f0-9]{32}$/);
        expect(response.headers.get('x-span-id')).toMatch(/^[a-f0-9]{16}$/);
        if (sampled) {
          expect(response.headers.get('x-trace-id')).toBe(trace);
          expect(response.headers.get('x-span-id')).toBe(span);
        } else expect([...response.headers.values()].join()).not.toContain('invalid-private-value');
        expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
        expect(response.headers.has('traceparent')).toBe(false);
        expect(events.length).toBe(sampled ? 3 : 1);
        for (const event of events) {
          expect(event.requestId).toBe(response.headers.get('x-request-id'));
          expect(event.traceId).toBe(response.headers.get('x-trace-id'));
          expect(event.spanId).toBe(response.headers.get('x-span-id'));
        }
      });
    }
  }
}

it('copies immutable Fetch response headers without consuming its stream or reflecting invalid trace context', async () => {
  // Response.redirect has immutable headers, unlike a constructed Response.
  const original = Response.redirect('http://local/elsewhere', 307);
  const router = createRouter({ middleware: [sharedLogger({ sample: 0 })], routes: [{ method: 'GET', path: '/', handler: () => original }] });
  const response = await router.handle(new Request('http://local/', { headers: { traceparent: 'invalid-private-value', 'x-trace-id': 'raw' } }));
  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe('http://local/elsewhere');
  expect(response.headers.get('x-trace-id')).toMatch(/^[a-f0-9]{32}$/);
  expect(response.headers.get('x-span-id')).toMatch(/^[a-f0-9]{16}$/);
  expect(original.headers.has('x-trace-id')).toBe(false);
  expect([...response.headers.values()].join()).not.toContain('invalid-private-value');
});

it('shared response wrapping preserves a streaming body and repeated cookie headers', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('streamed')); controller.close(); } });
  const original = new Response(body, { status: 202, statusText: 'Accepted', headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] });
  const router = createRouter({ middleware: [sharedLogger({ sample: 0 })], routes: [{ method: 'GET', path: '/', handler: () => original }] });
  const response = await router.handle(new Request('http://local/'));
  expect(response.body).toBe(body);
  expect(original.bodyUsed).toBe(false);
  expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  expect(response.status).toBe(202);
  expect(await response.text()).toBe('streamed');
});
