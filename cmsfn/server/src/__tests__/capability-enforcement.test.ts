import { expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { createCmsfnServer, type CmsfnServerConfig } from '../index.js';
import { fetchContentfnStatus, resolveStatusHeaders } from '../contentfn/statusClient.js';
const full = ['content.schema', 'content.docs', 'content.assets', 'content.audit', 'content.webhooks', 'content.realtime'];
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('address'); return `http://127.0.0.1:${addr.port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
it('checks startup and each dependent operation, preserves local storage, and probes only after authorization', async () => {
  let capabilities = [...full]; let status = 200; const calls: string[] = []; const credentials: unknown[] = [];
  const upstream = createServer((req, res) => {
    calls.push(req.url ?? ''); req.resume(); res.setHeader('content-type', 'application/json');
    if (req.url === '/contentfn/status') { credentials.push(req.headers.authorization); res.writeHead(status); res.end(JSON.stringify({ ok: true, result: { serverTime: new Date().toISOString(), capabilities } })); return; }
    res.end(JSON.stringify({ ok: true, result: req.url === '/contentfn/docs/get' ? { _id: 'drafts.a', _type: 'post', _rev: 'r1', _cms: { state: 'approved' } } : { _id: 'a', _type: 'post' } }));
  });
  const db = memoryAdapter(); let allowed = true;
  const config: CmsfnServerConfig = { db, contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' }, contentfnStatusHeaders: () => ({ authorization: 'Bearer status-service' }), getRolesForSubject: async () => allowed ? [{ id: 'all', name: 'All', rules: [{ datasets: '*', types: '*', actions: ['audit.read', 'release.manage', 'doc.publish', 'doc.unpublish', 'doc.read'] }] }] : [] };
  const cms = createCmsfnServer(config); expect(calls).toEqual([]);
  try {
    const base = await listen(cms); expect(await cms.readiness).toMatchObject({ ok: true }); expect(calls).toEqual(['/contentfn/status']); calls.length = 0;
    const post = async (path: string, body: unknown) => (await fetch(`${base}/cmsfn/${path}`, { method: 'POST', body: JSON.stringify(body) })).json();
    allowed = false; expect(await post('publish', { dataset: 'prod', id: 'a' })).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(await post('audit/events', { dataset: 'prod' })).toMatchObject({ error: { code: 'PERMISSION_DENIED' } }); allowed = true;
    expect(await post('publish', { dataset: 'unknown', id: 'a' })).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(await post('ops/export', { dataset: 'unknown' })).toMatchObject({ ok: false });
    expect(await post('preview/token', { dataset: 'prod' })).toMatchObject({ error: { code: 'PREVIEW_NOT_CONFIGURED' } }); expect(calls).toEqual([]);
    capabilities = []; expect(await post('publish', { dataset: 'prod', id: 'a' })).toMatchObject({ error: { code: 'CONTENTFN_UNAVAILABLE' } }); expect(calls).toEqual(['/contentfn/status']); calls.length = 0;
    expect(await post('releases/create', { dataset: 'prod', name: 'Local' })).toMatchObject({ ok: true }); expect(calls).toEqual([]);
    capabilities = ['content.docs']; expect(await post('publish', { dataset: 'prod', id: 'a' })).toMatchObject({ ok: true }); expect(calls).toEqual(['/contentfn/status', '/contentfn/docs/get', '/contentfn/docs/publish']); calls.length = 0;
    for (const path of ['ops/export', 'audit/events', 'audit/webhooks']) expect(await post(path, { dataset: 'prod' })).toMatchObject({ error: { code: 'CONTENTFN_UNAVAILABLE' } });
    expect(calls).toEqual(Array(3).fill('/contentfn/status')); calls.length = 0;
    capabilities = [...full]; status = 503; expect(await post('unpublish', { dataset: 'prod', id: 'a' })).toMatchObject({ error: { code: 'CONTENTFN_UNAVAILABLE' } }); expect(calls).toEqual(['/contentfn/status']);
    expect(credentials.every(value => value === 'Bearer status-service')).toBe(true);
  } finally { await close(cms); await close(upstream); await db.close(); }
});
it('exposes failed initial readiness, while disabled realtime is not required without preview', async () => {
  let capabilities = full.filter(value => value !== 'content.realtime');
  const upstream = createServer((req, res) => { req.resume(); res.end(JSON.stringify({ ok: true, result: { serverTime: new Date().toISOString(), capabilities } })); });
  const config: CmsfnServerConfig = { contentfn: { baseUrl: await listen(upstream) }, datasets: [], desk: { kind: 'divider' }, auth: { kind: 'custom' } };
  const normal = createCmsfnServer(config), preview = createCmsfnServer({ ...config, preview: { enabled: true, targetOrigin: 'https://example.test', resolveUrl: () => '' } });
  try { await listen(normal); await listen(preview); expect(await normal.readiness).toMatchObject({ ok: true }); expect(await preview.readiness).toMatchObject({ error: { code: 'CONTENTFN_UNAVAILABLE' } }); capabilities = []; }
  finally { await close(normal); await close(preview); await close(upstream); }
});
it('bounds malformed, oversized, redirected and stalled status bodies and credential resolution', async () => {
  let mode = 'malformed'; let redirected = 0;
  const target = createServer((req, res) => { redirected++; req.resume(); res.end('{}'); }); const targetBase = await listen(target);
  const upstream = createServer((req, res) => { req.resume(); if (mode === 'redirect') { res.writeHead(302, { location: targetBase }); res.end(); } else if (mode === 'stalled') { res.writeHead(200); res.write('{'); } else res.end(mode === 'large' ? 'x'.repeat(65537) : '{'); });
  try {
    const base = await listen(upstream);
    for (mode of ['malformed', 'large', 'redirect', 'stalled']) expect(await fetchContentfnStatus(base, false)).toBeNull();
    expect(redirected).toBe(0);
    await expect(resolveStatusHeaders(() => new Promise(() => undefined))).rejects.toThrow('timed out');
  } finally { await close(upstream); await close(target); }
}, 10_000);
it('requires actor-bound publish replay for configured scheduling readiness', async () => {
  const upstream = createServer((req, res) => { req.resume(); res.end(JSON.stringify({ ok: true, result: { serverTime: new Date().toISOString(), capabilities: full } })); });
  const db = memoryAdapter();
  const cms = createCmsfnServer({ db, contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' }, releaseExecutionSchemaVersion: 2, resolveReleaseExecutionIdentity: async () => ({ subject: 'service', roles: [], headers: {} }) });
  try {
    const base = await listen(cms);
    expect(await cms.readiness).toMatchObject({ ok: false, error: { code: 'CONTENTFN_UNAVAILABLE' } });
    expect(await (await fetch(base + '/cmsfn/status')).json()).toMatchObject({ ok: false, error: { code: 'CONTENTFN_UNAVAILABLE' } });
  } finally { await close(cms); await close(upstream); await db.close(); }
});
