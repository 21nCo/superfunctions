import { expect, it } from 'vitest';
import { createRouter } from '@superfunctions/http';
import { Logger } from '../core/logger.js';
import type { LogEvent } from '../types.js';
import { requestLogger, type LogRequestContext } from './shared.js';

it('shared router logs correlated request, application and completion events', async () => {
  const events: LogEvent[] = [];
  const logger = new Logger({ name: 'shared', sinks: [batch => { events.push(...batch); }] });
  const router = createRouter<LogRequestContext>({ middleware: [requestLogger({ logger, includeBody: true, captureUser: () => ({ userId: 'user' }) })], routes: [{ method: 'POST', path: '/echo', handler: async (_req, ctx) => {
    ctx.log!.info('application'); return new Response(await ctx.text());
  } }] });
  const response = await router.handle(new Request('http://local/echo', { method: 'POST', headers: { authorization: 'private' }, body: 'hello' }));
  expect(await response.text()).toBe('hello'); expect(events.map(event => event.msg)).toEqual(['Request started', 'application', 'Request completed']);
  expect(new Set(events.map(event => event.requestId)).size).toBe(1);
  expect(events.every(event => event.userId === 'user')).toBe(true);
  expect(events[0].ctx?.headers).toMatchObject({ authorization: '[redacted]' });
  expect(events[0].ctx?.body).toBe('hello');
});

it('sampling leaves the shared context logger available to the application', async () => {
  const events: LogEvent[] = [];
  const logger = new Logger({ name: 'shared', sinks: [batch => { events.push(...batch); }] });
  const router = createRouter<LogRequestContext>({ middleware: [requestLogger({ logger, sample: 0 })], routes: [{ method: 'GET', path: '/', handler: (_req, ctx) => {
    ctx.log!.info('application'); return new Response('ok');
  } }] });
  await router.handle(new Request('http://local/'));
  expect(events.map(event => event.msg)).toEqual(['application']);
});

it('records the shared router error response without exposing exception details', async () => {
  const events: LogEvent[] = [];
  const logger = new Logger({ name: 'shared', sinks: [batch => { events.push(...batch); }] });
  const router = createRouter<LogRequestContext>({ middleware: [requestLogger({ logger })], onError: () => new Response('unavailable', { status: 503 }), routes: [{ method: 'GET', path: '/', handler: () => { throw new Error('secret'); } }] });
  expect((await router.handle(new Request('http://local/'))).status).toBe(503);
  expect(events[1].ctx?.statusCode).toBe(503);
  expect(JSON.stringify(events)).not.toContain('secret');
});
