import { expect, it } from 'vitest';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { Logger } from '../core/logger.js';
import type { LogEvent } from '../types.js';
import { requestLogger as expressLogger } from './express.js';
import { requestLogger as fastifyLogger } from './fastify.js';
import { requestLogger as honoLogger } from './hono.js';
const headers = { authorization: 'Bearer private', cookie: 'session=private', 'x-custom-secret': 'private' };
const capture = () => {
  const events: LogEvent[] = [];
  return { events, logger: new Logger({ name: 'http', sinks: [batch => { events.push(...batch); }] }) };
};
const assertHeaders = (events: LogEvent[]) => {
  expect(events).toHaveLength(2);
  expect(events[0].ctx?.headers).toMatchObject({ authorization: '[redacted]', cookie: '[redacted]', 'x-custom-secret': '[redacted]' });
};
it('Express keeps default secret redaction when custom headers are configured', async () => {
  const { events, logger } = capture(); const app = express();
  app.use(expressLogger({ logger, redactHeaders: ['x-custom-secret'] })); app.get('/', (_req, res) => res.send('ok'));
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
  app.register(fastifyLogger({ logger, includeBody: true, redactHeaders: ['x-custom-secret'] }));
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
  app.use(honoLogger({ logger, redactHeaders: ['x-custom-secret'] })); app.get('/', c => c.text('ok'));
  expect((await app.request('/', { headers })).status).toBe(200); assertHeaders(events);
});
