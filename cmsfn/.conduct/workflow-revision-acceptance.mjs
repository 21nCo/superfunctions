// Copy into an isolated directory containing normally installed CmsFn/ContentFn tarballs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCmsfnServer } from '@cmsfn/server';
import { createContentfnServer } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters';

const contentDb = memoryAdapter(), cmsDb = memoryAdapter();
const content = createContentfnServer({ db: contentDb });
const unwrap = response => { assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
const calls = [], captured = new Map();
const changed = new Set(['single-race', 'a']);
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const upstream = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, body });
    const response = await content.router.handle(new Request(`http://producer${req.url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw }));
    const payload = await response.json();
    if (req.url === '/contentfn/docs/get' && payload.ok) {
      captured.set(body.id, payload.result._rev);
      const id = body.id.replace(/^drafts\./, '');
      if (changed.delete(id)) unwrap(await content.api.docs.patch({ dataset: 'prod', id: `drafts.${id}`, ifRev: payload.result._rev, ops: [{ op: 'set', path: '_cms.state', value: 'draft' }] }));
    }
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ fixtureError: String(error) })); }
});
const cms = createCmsfnServer({ contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' }, db: cmsDb,
  getRolesForSubject: async () => [{ id: 'publisher', name: 'Publisher', rules: [{ datasets: ['prod'], types: '*', actions: ['doc.publish', 'release.manage'] }] }],
});
try {
  unwrap(await content.api.datasets.create({ dataset: 'prod' }));
  unwrap(await content.api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } }));
  for (const id of ['single-race', 'single-stable', 'a', 'z']) unwrap(await content.api.docs.create({ dataset: 'prod', id, type: 'post', asDraft: true, doc: { title: id, _cms: { workflow: 'default', state: 'approved' } } }));
  const base = await listen(cms);
  const post = async (path, body) => (await fetch(`${base}/cmsfn/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const denied = await post('publish', { dataset: 'prod', id: 'single-race' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'CONFLICT');
  assert.equal(denied.error.details.upstreamCode, 'REV_CONFLICT');
  assert.equal(denied.error.details.expectedRev, captured.get('drafts.single-race'));
  assert.notEqual(denied.error.details.actualRev, denied.error.details.expectedRev);
  assert.equal((await content.api.docs.get({ dataset: 'prod', id: 'single-race' })).ok, false);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'drafts.single-race', perspective: 'draft' }))._cms.state, 'draft');
  unwrap(await post('publish', { dataset: 'prod', id: 'single-stable' }));
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'single-stable' }))._cms.state, 'approved');
  const { releaseId } = unwrap(await post('releases/create', { dataset: 'prod', name: 'Launch' }));
  for (const docId of ['z', 'a']) unwrap(await post('releases/add', { dataset: 'prod', releaseId, docId }));
  const release = unwrap(await post('releases/publish', { dataset: 'prod', releaseId }));
  assert.deepEqual(release.published, ['z']);
  assert.equal(release.failures.length, 1);
  assert.equal(release.failures[0].docId, 'a');
  assert.equal(release.failures[0].code, 'CONFLICT');
  assert.equal((await content.api.docs.get({ dataset: 'prod', id: 'a' })).ok, false);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'z' }))._cms.state, 'approved');
  const published = calls.filter(call => call.path === '/contentfn/docs/publish');
  assert.deepEqual(published.map(call => call.body.id), ['single-race', 'single-stable', 'a', 'z']);
  for (const { body } of published) assert.equal(body.ifRev, captured.get(`drafts.${body.id}`));
  console.log('Installed CmsFn → actual HTTP → ContentFn transaction/CAS: single and release races blocked; unchanged drafts published; release continued.');
} finally {
  for (const server of [cms, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await cmsDb.close(); await contentDb.close();
}
