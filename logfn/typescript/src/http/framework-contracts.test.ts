import { expect, it, vi } from 'vitest';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { Logger } from '../core/logger.js';
import type { LogEvent } from '../types.js';
import { requestLogger as expressLogger } from './express.js';
import { requestLogger as fastifyLogger } from './fastify.js';
import { requestLogger as honoLogger } from './hono.js';
const headers = { authorization: 'Bearer private', cookie: 'session=private', 'x-custom-secret': 'private', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
const capture = () => {
  const events: LogEvent[] = [];
  return { events, logger: new Logger({ name: 'http', sinks: [batch => { events.push(...batch); }] }) };
};
const assertHeaders = (events: LogEvent[]) => {
  expect(events).toHaveLength(2);
  expect(events[0].traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  expect(events[1].traceId).toBe(events[0].traceId);
  expect(events[1].requestId).toBe(events[0].requestId);
  expect(events[0]).toMatchObject({ userId: 'user', tenantId: 'tenant' });
  expect(events[1]).toMatchObject({ userId: 'user', tenantId: 'tenant' });
  expect(events[0].ctx?.headers).toMatchObject({ authorization: '[redacted]', cookie: '[redacted]', 'x-custom-secret': '[redacted]' });
};
it('Express keeps default secret redaction when custom headers are configured', async () => {
  const { events, logger } = capture(); const app = express();
  app.use(expressLogger({ logger, redactHeaders: ['x-custom-secret'], captureUser: () => ({ userId: 'user', tenantId: 'tenant' }) })); app.get('/', (_req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    expect((await fetch(`http://127.0.0.1:${address.port}`, { headers })).status).toBe(200);
    assertHeaders(events);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('Fastify logs parsed bodies without replacing its native request logger', async () => {
  const { events, logger } = capture(); const app = Fastify();
  app.register(fastifyLogger({ logger, includeBody: true, redactHeaders: ['x-custom-secret'], captureUser: () => ({ userId: 'user', tenantId: 'tenant' }) }));
  app.post('/', async request => {
    expect(typeof request.log.child).toBe('function');
    expect(request.logfn).toBeInstanceOf(Logger);
    return { ok: true };
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/', headers, payload: { visible: 'body' } });
    expect(response.statusCode).toBe(200); assertHeaders(events);
    expect(events[0].ctx?.body).toEqual({ visible: 'body' });
  } finally { await app.close(); }
});
it('Hono retains default secret redaction alongside custom headers', async () => {
  const { events, logger } = capture(); const app = new Hono();
  app.use(honoLogger({ logger, redactHeaders: ['x-custom-secret'], captureUser: () => ({ userId: 'user', tenantId: 'tenant' }) })); app.get('/', c => c.text('ok'));
  expect((await app.request('/', { headers })).status).toBe(200); assertHeaders(events);
});

it('Hono samples the whole automatic pair while preserving its request logger', async () => {
  const { events, logger } = capture(); const app = new Hono();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.75);
  app.use(honoLogger({ logger, sample: 0.5 })); app.get('/', c => c.text('ok'));
  try {
    await app.request('/', { headers }); expect(events).toHaveLength(0);
    random.mockReturnValue(0.25); await app.request('/', { headers }); expect(events).toHaveLength(2);
  } finally { random.mockRestore(); }
});
it('Fastify honors sample zero without removing the attached application logger', async () => {
  const { events, logger } = capture(); const app = Fastify();
  app.register(fastifyLogger({ logger, sample: { info: 0 } }));
  app.get('/', async request => { expect(request.logfn).toBeInstanceOf(Logger); return 'ok'; });
  try { expect((await app.inject('/')).statusCode).toBe(200); expect(events).toHaveLength(0); }
  finally { await app.close(); }
});
it('Express honors sample zero and leaves response.end intact', async () => {
  const { events, logger } = capture(); const app = express();
  app.use((_req, res, next) => { res.locals.originalEnd = res.end; next(); });
  app.use(expressLogger({ logger, sample: 0 })); app.get('/', (_req, res) => { expect(res.end).toBe(res.locals.originalEnd); res.send('ok'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try { await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}`); expect(events).toHaveLength(0); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it.each([NaN, Infinity, -1, 2])('rejects invalid sampling rates at setup %s', sample => {
  expect(() => expressLogger({ sample })).toThrow('sample');
  expect(() => fastifyLogger({ sample })).toThrow('sample');
  expect(() => honoLogger({ sample })).toThrow('sample');
});

it('child correlation inherits parent fields without mutating the parent', () => {
  const events: LogEvent[] = [];
  const logger = new Logger({ name: 'parent', correlation: { traceId: 'trace', tenantId: 'tenant' }, sinks: [batch => { events.push(...batch); }] });
  logger.child({ correlation: { requestId: 'child' } }).info('child'); logger.info('parent');
  expect(events[0]).toMatchObject({ traceId: 'trace', tenantId: 'tenant', requestId: 'child' });
  expect(events[1]).toMatchObject({ traceId: 'trace', tenantId: 'tenant' });
  expect(events[1].requestId).toBeUndefined();
});


it('Hono bounds captured prefixes while the route reads the complete request', async () => {
  const { events, logger } = capture(); const app = new Hono();
  app.use(honoLogger({ logger, includeBody: true }));
  app.post('/', async c => c.text(await c.req.text()));
  const body = '😀'.repeat(20000);
  const response = await app.request('/', { method: 'POST', body });
  expect(await response.text()).toBe(body);
  expect(events[0].ctx?.body).toMatchObject({ _truncated: true, _capturedBytes: 8192 });
  expect(JSON.stringify(events[0].ctx?.body).length).toBeLessThan(1000);
});

it('Hono does not hold a route indefinitely for a stalled body', async () => {
  const { events, logger } = capture(); const app = new Hono();
  app.use(honoLogger({ logger, includeBody: true, bodyCaptureTimeoutMs: 10 }));
  app.post('/', c => c.text('ok'));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const request = new Request('http://localhost/', { method: 'POST', body, duplex: 'half' } as RequestInit);
  try {
    const response = await app.request(request);
    expect(await response.text()).toBe('ok');
    expect(events[0].ctx?.body).toEqual({ _omitted: 'body_capture_timeout' });
  } finally { controller.close(); }
});


it('Hono and Fastify attach a usable default logger when none is supplied', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const app = new Hono();
  app.use(honoLogger());
  app.get('/', c => { expect(c.get('log')).toBeInstanceOf(Logger); return c.text('ok'); });
  const fastify = Fastify(); fastify.register(fastifyLogger());
  fastify.get('/', request => { expect(request.logfn).toBeInstanceOf(Logger); return 'ok'; });
  try {
    expect((await app.request('/')).status).toBe(200);
    expect((await fastify.inject('/')).statusCode).toBe(200);
    expect(output).toHaveBeenCalledTimes(4);
  } finally { await fastify.close(); output.mockRestore(); }
});

it('Express attaches a usable default logger when none is supplied', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const app = express(); app.use(expressLogger());
  app.get('/', (req, res) => { expect((req as any).log).toBeInstanceOf(Logger); res.send('ok'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    expect((await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}`)).status).toBe(200);
    expect(output).toHaveBeenCalledTimes(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); output.mockRestore(); }
});
