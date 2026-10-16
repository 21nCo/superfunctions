import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { browseFn } from '../src/index.js';

let server: Server;
let url: string;
let calls: number;
let failCount: number;
let status: number;
beforeEach(async () => {
  calls = 0; failCount = 1; status = 503;
  server = createServer((_req, response) => { calls++; response.writeHead(calls <= failCount ? status : 200, { 'content-type': 'text/html' }); response.end('<title>done</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const retry = { enabled: true, maxAttempts: 5, delay: 1, backoff: 'linear' as const, retryOn: [503] };
it('retries a real upstream 503 and preserves successful output', async () => {
  expect((await browseFn({ retry }).web.getPage(url)).metadata.title).toBe('done');
  expect(calls).toBe(2);
});
it('does not retry an upstream status outside retryOn', async () => {
  status = 404;
  await expect(browseFn({ retry }).web.getPage(url)).rejects.toMatchObject({ code: 'UPSTREAM_NOT_FOUND', details: { statusCode: 404 } });
  expect(calls).toBe(1);
});
it('applies per-call retries without global configuration', async () => {
  expect((await browseFn().web.getPage(url, { retry: { count: 1, delay: 0 } })).metadata.title).toBe('done');
  expect(calls).toBe(2);
});
it('per-call count overrides global attempts including zero', async () => {
  failCount = 100;
  await expect(browseFn({ retry }).web.getPage(url, { retry: { count: 1, delay: 0 } })).rejects.toMatchObject({ details: { statusCode: 503 } });
  expect(calls).toBe(2);
  calls = 0;
  await expect(browseFn({ retry }).web.getPage(url, { retry: { count: 0, delay: 0 } })).rejects.toMatchObject({ details: { statusCode: 503 } });
  expect(calls).toBe(1);
});
it('rejects invalid per-call retry before requesting', async () => {
  await expect(browseFn().web.getPage(url, { retry: { count: -1, delay: 0 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(calls).toBe(0);
});
