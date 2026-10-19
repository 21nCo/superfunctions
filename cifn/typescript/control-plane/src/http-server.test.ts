import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { createControlPlaneServer } from './http-server.js';
import { createApp } from './api/routes.js';
import { MemorySecFnClient } from './secrets/secfn-client.js';
import { MAX_REQUEST_BODY_BYTES } from './api/body.js';

const servers: ReturnType<typeof createControlPlaneServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
  server.close(() => resolve()); server.closeAllConnections();
}))); });
async function listen(app: Parameters<typeof createControlPlaneServer>[0]) {
  const server = createControlPlaneServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no address');
  return `http://127.0.0.1:${address.port}`;
}
async function setup() {
  const secrets = new MemorySecFnClient();
  await secrets.setSecret('CIFN_API_KEYS', 'key');
  await secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', 'register');
  const result = createApp({ secFn: secrets, webhookSecret: 'secret' });
  return { ...result, url: await listen(result.app) };
}
const auth = { Authorization: 'Bearer key' };
it('rejects a declared oversized body before receiving it or invoking the app', async () => {
  const fetch = vi.fn(() => new Response('ok'));
  const url = await listen({ fetch });
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url + '/api/v1/runs', { method: 'POST', headers: { 'Content-Length': MAX_REQUEST_BODY_BYTES + 1 } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode!, body }); req.destroy(); });
    });
    req.on('error', reject); req.flushHeaders();
  });
  expect(result.status).toBe(413);
  expect(JSON.parse(result.body)).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds streamed UTF-8 bytes and accepts the exact limit', async () => {
  const handler = vi.fn(async (req: Request) => new Response(await req.text()));
  const url = await listen({ fetch: handler });
  const exact = 'é'.repeat(MAX_REQUEST_BODY_BYTES / 2);
  expect((await fetch(url, { method: 'POST', body: exact })).status).toBe(200);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(exact)); controller.enqueue(Buffer.from('x')); controller.close();
  } });
  const response = await fetch(url, { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  expect(response.status).toBe(413);
  expect(handler).toHaveBeenCalledTimes(1);
});
it.each(['/api/v1/runs', '/api/v1/runners/register', '/api/v1/runners/heartbeat'])('rejects malformed/non-object JSON at %s', async path => {
  const { url } = await setup();
  for (const body of ['{', 'null', '[]', '42']) {
    const response = await fetch(url + path, { method: 'POST', headers: auth, body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  }
});
it('creates a valid run and keeps health available', async () => {
  const { url } = await setup();
  const response = await fetch(url + '/api/v1/runs', { method: 'POST', headers: auth, body: JSON.stringify({
    trigger: { type: 'workflow_dispatch' }, pipelineSpec: { name: 'test', on: { workflow_dispatch: {} }, jobs: {
      build: { 'runs-on': 'default', steps: [{ run: 'echo ok' }] },
    } },
  }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ ok: true });
  expect(await (await fetch(url + '/health')).json()).toEqual({ ok: true });
});
it('preserves webhook text signatures and bounds direct Hono consumers', async () => {
  const { app, url } = await setup();
  const body = '{ "message": "é", "value": 1 }';
  const signature = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
  const response = await fetch(url + '/webhooks/github', { method: 'POST', body, headers: {
    'X-Hub-Signature-256': signature, 'X-GitHub-Event': 'ping',
  } });
  expect(await response.json()).toMatchObject({ error: { message: 'Unsupported event type: ping' } });
  for (const path of ['/api/v1/runs', '/api/v1/runners/register', '/api/v1/runners/heartbeat', '/webhooks/github']) {
    const result = await app.request('http://localhost' + path, { method: 'POST', headers: auth, body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1) });
    expect(result.status).toBe(413);
  }
});
it('contains application failures without an unhandled request rejection', async () => {
  const url = await listen({ fetch: async () => { throw new Error('private failure'); } });
  const response = await fetch(url + '/api/v1/runs', { method: 'POST', body: '{}' });
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

it('accepts runner registration and authenticated heartbeat over HTTP', async () => {
  const { url } = await setup();
  const response = await fetch(url + '/api/v1/runners/register', { method: 'POST', body: JSON.stringify({ token: 'register' }) });
  expect(response.status).toBe(200);
  const result = await response.json() as { data: { runnerId: string; runnerSecret: string } };
  const heartbeat = await fetch(url + '/api/v1/runners/heartbeat', {
    method: 'POST', headers: { Authorization: `Bearer ${result.data.runnerSecret}` },
    body: JSON.stringify({ runnerId: result.data.runnerId }),
  });
  expect(heartbeat.status).toBe(200);
  expect(await heartbeat.json()).toMatchObject({ ok: true, data: { job: null } });
});
