import { expect, it } from 'vitest';
import { watchLogsRouter } from './watch.js';

const event = { ts: '2026-10-18T00:00:00.000Z', name: 'test', msg: 'hello', level: 'info', version: '0' };
const request = (path: string, token?: string) => new Request(`http://localhost${path}`, {
  method: 'POST', headers: token ? { authorization: token } : {}, body: JSON.stringify({ events: [event] }),
});

it('uses the shared router contract for path, method, auth and durable ingestion', async () => {
  const batches: unknown[] = [];
  const router = watchLogsRouter({ auth: { header: 'authorization', value: 'token' }, ingest: async events => { batches.push(events); } });
  expect(router.getRoutes()).toHaveLength(1);
  expect(router.match('POST', '/watch/logs')?.route.meta?.openapi?.operationId).toBe('ingestLogs');
  expect((await router.handle(request('/missing', 'token'))).status).toBe(404);
  const wrongMethod = await router.handle(new Request('http://localhost/watch/logs'));
  expect(wrongMethod.status).toBe(405); expect(wrongMethod.headers.get('allow')).toContain('POST');
  expect((await router.handle(request('/watch/logs'))).status).toBe(401);
  expect(batches).toHaveLength(0);
  expect((await router.handler(request('/watch/logs', 'token'))).status).toBe(202);
  expect(batches).toEqual([[event]]);
});

it('supports mounted prefixes and preserves ingress failure responses', async () => {
  const router = watchLogsRouter({ basePath: '/api', path: '/logs', ingest: () => { throw new Error('storage unavailable'); } });
  expect((await router.handle(request('/api/logs'))).status).toBe(503);
  expect((await router.handle(request('/watch/logs'))).status).toBe(404);
});
