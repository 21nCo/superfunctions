import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { middleware } from '../src/middleware/express.js';
import { hono } from '../src/middleware/hono.js';
import { fastify } from '../src/middleware/fastify.js';
import { eligible, key, snapshot } from '../src/middleware/http-cache.js';
function store() {
  const values = new Map();
  return { get: vi.fn(async (k: string) => values.get(k)), set: vi.fn(async (k: string, v: unknown) => { values.set(k, v); }) } as any;
}
function response(status = 200, initial: Record<string, string> = {}) {
  const h = { ...initial };
  return { statusCode: status, body: undefined as unknown, getHeaders: () => h,
    setHeader(k: string, v: string) { h[k] = v; },
    status(s: number) { this.statusCode = s; return this; },
    json(v: unknown) { h['content-type'] = 'application/json'; this.body = v; return this; },
  };
}
describe('HTTP response cache safety', () => {
  it('partitions configured vary and host without ambiguous keys', () => {
    expect(key('/x', { host: 'a', accept: 'json' }, ['Accept'])).not.toBe(key('/x', { host: 'a', accept: 'html' }, ['accept']));
    expect(key('/x', { host: 'a' })).not.toBe(key('/x', { host: 'b' }));
  });
  it.each(['authorization', 'cookie', 'range', 'if-none-match', 'if-modified-since'])('bypasses %s requests', name => {
    expect(eligible('GET', { [name]: 'value' })).toBe(false);
  });
  it.each([{ 'set-cookie': 'session=secret' }, { 'cache-control': 'private' }, { 'cache-control': 'no-store' }, { vary: 'Cookie' }, { vary: '*' }, { 'cache-control': 'max-age=1' }])('rejects unsafe response %j', h => {
    expect(snapshot(200, h, false, 'json')).toBeUndefined();
  });
  it('rejects errors and partial responses and strips hop headers', () => {
    expect(snapshot(500, {}, 'bad', 'text')).toBeUndefined();
    expect(snapshot(206, {}, 'partial', 'text')).toBeUndefined();
    expect(snapshot(200, { connection: 'x-hop', 'x-hop': 'secret', 'content-length': '9' }, '', 'text')?.headers).toEqual({});
  });
  it.each([false, 0, '', null])('Express replays falsy JSON %j with status and headers', async value => {
    const cache = store(); const run = middleware({ cache }); const req = { method: 'GET', url: '/x', headers: {} };
    const first = response(201, { 'x-result': 'created' });
    await run(req, first, () => first.json(value));
    const second = response(); const next = vi.fn(); await run(req, second, next);
    expect(next).not.toHaveBeenCalled(); expect(second.body).toBe(value); expect(second.statusCode).toBe(201); expect(second.getHeaders()['x-result']).toBe('created');
  });
  it('Express preserves serialized output without applying a replacer twice', async () => {
    const cache = store(); const run = middleware({ cache }); const req = { method: 'GET', url: '/wire', headers: {} };
    const make = () => ({ ...response(), send(v: unknown) { this.body = v; return this; }, json(v: any) { return this.send(JSON.stringify({ ...v, count: v.count + 1 })); } });
    const first = make(); await run(req, first, () => first.json({ count: 1 }));
    const second = make(); await run(req, second, vi.fn());
    expect(first.body).toBe('{"count":2}'); expect(second.body).toBe(first.body);
  });
  it('runs through actual Hono requests with representation variation and privacy bypass', async () => {
    const cache = store(); const app = new Hono(); let calls = 0;
    app.use('*', hono({ cache, vary: ['accept-language'] }));
    app.get('/value', c => { calls++; c.header('Vary', 'Accept-Language'); c.header('X-Origin', 'yes'); return c.text(c.req.header('accept-language') ?? 'default', 201); });
    const request = (language: string, extra = {}) => app.request('/value', { headers: { 'accept-language': language, ...extra } });
    expect(await (await request('en')).text()).toBe('en');
    const cached = await request('en'); expect(cached.status).toBe(201); expect(cached.headers.get('x-origin')).toBe('yes'); expect(await cached.text()).toBe('en'); expect(calls).toBe(1);
    expect(await (await request('fr')).text()).toBe('fr'); expect(calls).toBe(2);
    await request('en', { authorization: 'Bearer secret' }); expect(calls).toBe(3);
  });
  it.each(['if-match', 'if-unmodified-since'])('preserves failed %s preconditions after warming the cache', async header => {
    const cache = store(); const app = new Hono(); let calls = 0;
    app.use('*', hono({ cache }));
    app.get('/conditional', c => {
      calls++;
      if (c.req.header(header)) return c.text('precondition failed', 412);
      return c.text('current');
    });
    expect((await app.request('/conditional')).status).toBe(200);
    const conditional = await app.request('/conditional', { headers: { [header]: header === 'if-match' ? '"stale"' : 'Wed, 01 Jan 2020 00:00:00 GMT' } });
    expect(conditional.status).toBe(412);
    expect(await conditional.text()).toBe('precondition failed');
    expect(calls).toBe(2);
  });
  it('runs through actual Express HTTP requests preserving status, serialized JSON and vary headers', async () => {
    const express = require('express'); const app = express(); const cache = store(); let calls = 0;
    app.set('json replacer', (key: string, value: unknown) => key === 'count' ? Number(value) + 1 : value);
    app.use(middleware({ cache, vary: ['accept-language'] }));
    app.get('/value', (req: any, res: any) => { calls++; res.status(201).set('Vary', 'Accept-Language').set('X-Origin', 'yes').json({ count: 1, language: req.get('accept-language') }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/value`;
    try {
      const first = await fetch(url, { headers: { 'accept-language': 'en' } }); expect(await first.json()).toEqual({ count: 2, language: 'en' });
      const second = await fetch(url, { headers: { 'Accept-Language': 'en' } }); expect(second.status).toBe(201); expect(second.headers.get('x-origin')).toBe('yes'); expect(await second.json()).toEqual({ count: 2, language: 'en' }); expect(calls).toBe(1);
      await fetch(url, { headers: { 'accept-language': 'fr' } }); expect(calls).toBe(2);
      await fetch(url, { headers: { cookie: 'session=secret', 'accept-language': 'en' } }); expect(calls).toBe(3);
    } finally { await new Promise<void>((resolve, reject) => server.close((err: Error) => err ? reject(err) : resolve())); }
  });
  it('Express reapplies compression to cached plaintext without encoding header mismatch', async () => {
    const express = require('express');
    const compression = require('compression');
    const app = express(); const cache = store(); let calls = 0;
    app.use(compression({ threshold: 0 }));
    app.use(middleware({ cache, vary: ['accept-encoding'] }));
    app.get('/compressed', (_req: any, res: any) => {
      calls++; res.json({ message: 'compress this response'.repeat(100) });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/compressed`;
    try {
      for (let i = 0; i < 2; i++) {
        const response = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
        expect(response.headers.get('content-encoding')).toBe('gzip');
        expect(await response.json()).toEqual({ message: 'compress this response'.repeat(100) });
      }
      expect(calls).toBe(1);
      expect(cache.set).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err: Error) => err ? reject(err) : resolve()));
    }
  });
  it('runs through actual Fastify injection preserving serialized bytes, status and Vary', async () => {
    const app = require('fastify')(); const cache = store(); let calls = 0;
    await fastify(app, { cache });
    app.get('/value', { config: { cachefn: { vary: ['accept-language'] } } }, async (req: any, reply: any) => { calls++; return reply.code(201).header('vary', 'Accept-Language').header('content-type', 'application/octet-stream').send(Buffer.from(req.headers['accept-language'] ?? 'default')); });
    try {
      const first = await app.inject({ url: '/value', headers: { 'accept-language': 'en' } }); expect(first.body).toBe('en');
      const second = await app.inject({ url: '/value', headers: { 'Accept-Language': 'en' } }); expect(second.statusCode).toBe(201); expect(second.headers['content-type']).toBe('application/octet-stream'); expect(second.body).toBe('en'); expect(calls).toBe(1);
      await app.inject({ url: '/value', headers: { 'accept-language': 'fr' } }); expect(calls).toBe(2);
      await app.inject({ url: '/value', headers: { authorization: 'Bearer secret', 'accept-language': 'en' } }); expect(calls).toBe(3);
    } finally { await app.close(); }
  });
  it('Express bypasses cache outages', async () => {
    const cache = store(); cache.get.mockRejectedValue(new Error('offline')); cache.set.mockRejectedValue(new Error('offline'));
    const res = response(); await middleware({ cache })({ method: 'GET', url: '/', headers: {} }, res, () => res.json(false));
    expect(res.body).toBe(false);
  });
  it('Hono preserves arbitrary bytes, status and headers', async () => {
    const cache = store(); const run = hono({ cache });
    const make = () => ({ req: { method: 'GET', url: 'http://example/x', raw: new Request('http://example/x') }, res: new Response() });
    const first = make(); await run(first, () => { first.res = new Response(new Uint8Array([0, 255, 42]), { status: 201, headers: { 'content-type': 'application/octet-stream', 'x-result': 'binary' } }); });
    const second = make(); const next = vi.fn(); await run(second, next);
    expect(next).not.toHaveBeenCalled(); expect(second.res.status).toBe(201); expect(second.res.headers.get('x-result')).toBe('binary'); expect(Array.from(new Uint8Array(await second.res.arrayBuffer()))).toEqual([0, 255, 42]);
  });
  it('Hono preserves error responses and origin exceptions', async () => {
    const cache = store(); const run = hono({ cache }); const c = { req: { method: 'GET', url: 'http://example/x', raw: new Request('http://example/x') }, res: new Response('failed', { status: 500 }) };
    await run(c, async () => {}); expect(cache.set).not.toHaveBeenCalled(); expect(await c.res.text()).toBe('failed');
    await expect(run(c, async () => { throw new Error('origin'); })).rejects.toThrow('origin');
  });
  it('Fastify uses one request eligibility decision for both lookup and store, and does not refresh hits', async () => {
    const cache = store(); const hooks: Record<string, Function> = {};
    await fastify({ decorate() {}, addHook(name: string, fn: Function) { hooks[name] = fn; } }, { cache });
    const make = (method = 'GET', condition = true) => ({ method, url: '/x', headers: {}, routeOptions: { config: { cachefn: { condition: () => condition } } } });
    const reply = () => ({ statusCode: 201, sent: false, body: undefined as unknown, getHeaders: () => ({ 'content-type': 'text/plain', 'x-result': 'ok' }), code(s: number) { this.statusCode = s; return this; }, headers: vi.fn(), send(v: unknown) { this.body = v; return this; } });
    for (const req of [make('POST'), make('GET', false)]) { await hooks.preHandler(req, reply()); await hooks.onSend(req, reply(), 'ignored'); }
    expect(cache.set).not.toHaveBeenCalled();
    const a = make(); await hooks.preHandler(a, reply()); await hooks.onSend(a, reply(), '');
    const b = make(); const hit = reply(); hit.statusCode = 200; await hooks.preHandler(b, hit); await hooks.onSend(b, hit, '');
    expect(hit.body).toBe(''); expect(hit.statusCode).toBe(201); expect(cache.set).toHaveBeenCalledTimes(1);
  });
});
