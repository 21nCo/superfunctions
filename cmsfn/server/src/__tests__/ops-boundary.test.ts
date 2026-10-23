import { expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCmsfnServer, type CmsfnServerConfig } from '../index.js';
const artifact = { formatVersion: 1, dataset: 'prod', exportedAt: '2026-10-23T00:00:00Z', schema: null, publishedDocs: [], draftDocs: [], assets: [], revisions: [] };
const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('address'); return `http://127.0.0.1:${address.port}`; };
async function fixture(run: (base: string, config: CmsfnServerConfig, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const upstream = createServer((req, res) => { calls.push(req.url ?? ''); req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: req.url?.endsWith('/export') ? { artifact } : {} })); });
  const config: CmsfnServerConfig = { contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: 'prod' }, { name: 'staging' }], desk: { kind: 'divider' }, auth: { kind: 'custom' } };
  const cms = createCmsfnServer(config);
  try { await run(await listen(cms), config, calls); } finally { for (const server of [cms, upstream]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
}
const post = async (base: string, path: string, body: unknown) => (await fetch(`${base}/cmsfn/ops/${path}`, { method: 'POST', body: JSON.stringify(body) })).json();
it('denies missing or throwing authorization before forwarding export/import', async () => fixture(async (base, config, calls) => {
  for (const roles of [undefined, async () => { throw Error('identity down'); }, async () => []]) {
    config.getRolesForSubject = roles;
    for (const action of ['export', 'import']) expect(await post(base, action, { dataset: 'prod', artifact })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  }
  expect(calls).toEqual([]);
}));
it('denies cross-dataset imports by default', async () => fixture(async (base, config, calls) => {
  config.getRolesForSubject = async () => [{ id: 'ops', name: 'Ops', rules: [{ datasets: '*', types: '*', actions: ['audit.read'] }] }];
  expect(await post(base, 'import', { dataset: 'staging', artifact })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  expect(calls).toEqual([]);
}));
it('requires explicit migration policy after target authorization and fails closed on callback errors', async () => fixture(async (base, config, calls) => {
  const seen: unknown[] = [];
  config.getRolesForSubject = async () => [{ id: 'ops', name: 'Ops', rules: [{ datasets: ['staging'], types: '*', actions: ['audit.read'] }] }];
  config.authorizeCrossDatasetImport = async (req, input) => { seen.push({ ...input, method: req.method }); return true; };
  expect(await post(base, 'import', { dataset: 'staging', artifact })).toMatchObject({ ok: true });
  expect(seen).toEqual([{ sourceDataset: 'prod', targetDataset: 'staging', method: 'POST' }]);
  expect(calls).toHaveLength(1);
  config.getRolesForSubject = async () => [];
  expect(await post(base, 'import', { dataset: 'staging', artifact })).toMatchObject({ error: { code: 'PERMISSION_DENIED' } }); expect(seen).toHaveLength(1);
  config.getRolesForSubject = async () => [{ id: 'ops', name: 'Ops', rules: [{ datasets: '*', types: '*', actions: ['audit.read'] }] }];
  config.authorizeCrossDatasetImport = async () => { throw Error('private-policy-secret'); };
  const failed = await post(base, 'import', { dataset: 'staging', artifact }); expect(failed).toMatchObject({ error: { code: 'PERMISSION_DENIED' } }); expect(JSON.stringify(failed)).not.toContain('private-policy-secret');
  config.contentfnOpsHeaders = async () => { throw Error('private-service-secret'); };
  const exportFailure = await post(base, 'export', { dataset: 'prod' }); expect(exportFailure).toMatchObject({ error: { code: 'CONTENTFN_UNAVAILABLE' } }); expect(JSON.stringify(exportFailure)).not.toContain('private-service-secret'); expect(calls).toHaveLength(1);
}));
it('rejects malformed and oversized bodies before reaching the producer', async () => fixture(async (base, config, calls) => {
  config.getRolesForSubject = async () => [{ id: 'ops', name: 'Ops', rules: [{ datasets: '*', types: '*', actions: ['audit.read'] }] }];
  for (const body of ['{', 'null', '[]']) expect(await (await fetch(`${base}/cmsfn/ops/import`, { method: 'POST', body })).json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  expect(await post(base, 'export', { dataset: 'prod', excess: 'x'.repeat(64 * 1024) })).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  expect(await post(base, 'import', { dataset: 'prod', artifact, excess: 'x'.repeat(25 * 1024 * 1024) })).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  expect(await post(base, 'import', { dataset: 'prod', artifact: { dataset: 'prod', formatVersion: 1 } })).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  expect(calls).toEqual([]);
}));
