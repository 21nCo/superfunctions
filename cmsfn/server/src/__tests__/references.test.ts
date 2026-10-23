import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createCmsfnServer } from '../index.js';
import { compatibleStatus } from './compatibleStatus.js';
import { readResponse, field } from './responseHelpers.js';
const servers: Server[] = [];
async function listen(server: Server) { servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error(); return `http://127.0.0.1:${address.port}`; }
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
it('enforces every requested type and dataset before upstream, and uses canonical trusted query identity', async () => {
  const queries: Record<string, unknown>[] = []; const auth: unknown[] = []; let mode: 'allow' | 'deny' | 'throw' = 'allow'; let upstreamDenied = false; let roleCalls = 0;
  const upstream = await listen(createServer((req, res) => {
    if (req.url === '/contentfn/status') { res.end(JSON.stringify(compatibleStatus)); return; }
    let body = ''; req.on('data', chunk => { body += String(chunk); }); req.on('end', () => {
      queries.push(JSON.parse(body)); auth.push(req.headers.authorization);
      if (upstreamDenied) { res.writeHead(403); res.end('<html>Denied</html>'); return; }
      res.end(JSON.stringify({ ok: true, result: { data: [{ _id: 'author-1', _type: 'author', title: 'A'.repeat(500), privateBody: 'must not leave producer response' }], nextCursor: null } }));
    });
  }));
  const cms = await listen(createCmsfnServer({ contentfn: { baseUrl: upstream }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' }, getRolesForSubject: async () => { roleCalls++; if (mode === 'throw') throw Error('private'); return mode === 'deny' ? [] : [{ id: 'reader', name: 'Reader', rules: [{ datasets: ['prod'], types: ['author'], actions: ['doc.read'] }] }]; }, contentfnReferenceHeaders: () => ({ authorization: 'Bearer trusted-service' }) }));
  const post = async (body: unknown) => readResponse(await fetch(`${cms}/cmsfn/references/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer browser-secret' }, body: JSON.stringify(body) }));
  for (const body of [{ dataset: 'other', types: ['author'] }, { dataset: 'prod', types: ['author', 'secret'] }]) expect(field(await post(body), 'error.code')).toBe('PERMISSION_DENIED');
  expect(field(await post({ dataset: 'prod', types: [] }), 'error.code')).toBe('VALIDATION_FAILED');
  for (mode of ['deny', 'throw'] as const) expect(field(await post({ dataset: 'prod', types: ['author'] }), 'error.code')).toBe('PERMISSION_DENIED');
  expect(queries).toHaveLength(0); expect(roleCalls).toBe(3); mode = 'allow';
  const result = await post({ dataset: 'prod', types: ['author'], search: 'Alice', projection: { fields: ['privateBody'] }, perspective: 'draft' });
  expect(field(result, 'result.dataset')).toBe('prod'); expect(field(result, 'result.data')).toEqual([{ _id: 'author-1', _type: 'author', label: 'A'.repeat(160) }]);
  expect(auth).toEqual(['Bearer trusted-service']); expect(queries[0]).toMatchObject({ perspective: 'published', projection: { fields: ['_id', '_type', 'title', 'name'] }, types: ['author'], filter: { op: 'or' }, limit: 20 });
  upstreamDenied = true; expect(field(await post({ dataset: 'prod', types: ['author'] }), 'error.code')).toBe('PERMISSION_DENIED');
});
it('shrinks oversized pages at the same cursor and rejects foreign metadata', async () => {
  const limits: number[] = []; let wrong = false;
  const upstream = await listen(createServer((req, res) => {
    if (req.url === '/contentfn/status') { res.end(JSON.stringify(compatibleStatus)); return; }
    let body = ''; req.on('data', chunk => { body += String(chunk); }); req.on('end', () => {
      const input = JSON.parse(body); limits.push(input.limit); expect(input.cursor).toBe('same-cursor');
      if (input.limit > 5) { res.setHeader('content-length', '3000000'); res.end(' '.repeat(3000000)); return; }
      res.end(JSON.stringify({ ok: true, result: { dataset: wrong ? 'staging' : 'prod', data: [{ _id: 'author-1', _type: 'author', title: { unsafe: true } }], nextCursor: null } }));
    });
  }));
  const cms = await listen(createCmsfnServer({ contentfn: { baseUrl: upstream }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' }, getRolesForSubject: async () => [{ id: 'reader', name: 'Reader', rules: [{ datasets: '*', types: '*', actions: ['doc.read'] }] }] }));
  const post = async () => readResponse(await fetch(`${cms}/cmsfn/references/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset: 'prod', types: ['author'], cursor: 'same-cursor' }) }));
  expect(field(await post(), 'result.data')).toEqual([{ _id: 'author-1', _type: 'author', label: 'author-1' }]); expect(limits).toEqual([20, 10, 5]);
  wrong = true; expect(field(await post(), 'ok')).toBe(false);
});
