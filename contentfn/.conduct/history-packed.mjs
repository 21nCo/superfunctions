import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createContentfnServer, getHistoryIndexDefinition, upgradeHistoryIndexSchema } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const db = memoryAdapter(); let allowed = true;
const content = createContentfnServer({ db, authorize: (_context, action) => action !== 'docs.history' || allowed });
const http = createServer(content.handler);
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${http.address().port}`;
  const post = async (path, input) => (await fetch(base + '/contentfn/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json();
  for (const dataset of ['prod', 'other']) {
    assert.equal((await post('datasets/create', { dataset })).ok, true);
    assert.equal((await post('schema/upsert', { dataset, schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } })).ok, true);
  }
  assert.equal((await post('docs/create', { dataset: 'prod', id: 'one', type: 'post', doc: { title: 'first' }, asDraft: true })).ok, true);
  for (const title of ['second', 'third']) assert.equal((await post('docs/patch', { dataset: 'prod', id: 'drafts.one', ops: [{ op: 'set', path: 'title', value: title }] })).ok, true);
  assert.equal((await post('docs/publish', { dataset: 'prod', id: 'one' })).ok, true);
  const first = await post('docs/history', { dataset: 'prod', id: 'one', limit: 1 });
  assert.equal(first.ok, true); assert.ok(first.result.nextCursor);
  const pages = [...first.result.revisions]; let cursor = first.result.nextCursor;
  while (cursor) { const page = await post('docs/history', { dataset: 'prod', id: 'drafts.one', limit: 1, cursor }); assert.equal(page.ok, true); pages.push(...page.result.revisions); cursor = page.result.nextCursor; }
  // Publishing records both the locked draft revision and published snapshot.
  assert.equal(pages.length, 5); assert.equal(new Set(pages.map(doc => `${doc._id}:${doc._rev}`)).size, 5);
  assert.ok(pages.some(doc => doc._id === 'one')); assert.ok(pages.some(doc => doc.title === 'first'));
  for (const scope of [{ dataset: 'other', id: 'one' }, { dataset: 'prod', id: 'another' }]) assert.equal((await post('docs/history', { ...scope, cursor: first.result.nextCursor })).error.code, 'VALIDATION_FAILED');
  const longId = 'unicode-文'.repeat(3000);
  assert.equal((await post('docs/create', { dataset: 'prod', id: longId, type: 'post', doc: { title: 'long-id' }, asDraft: true })).ok, true);
  assert.equal((await post('docs/patch', { dataset: 'prod', id: `drafts.${longId}`, ops: [{ op: 'set', path: 'title', value: 'changed' }] })).ok, true);
  const longPage = await post('docs/history', { dataset: 'prod', id: longId, limit: 1 });
  assert.equal(longPage.ok, true); assert.ok(longPage.result.nextCursor.length < 1024);
  assert.equal((await post('docs/history', { dataset: 'prod', id: longId, limit: 1, cursor: longPage.result.nextCursor })).ok, true);
  assert.deepEqual(getHistoryIndexDefinition().directions, ['asc', 'asc', 'desc', 'asc', 'asc']);
  await assert.rejects(upgradeHistoryIndexSchema({ async ensureOrderedIndex() { throw Error('Host migration failed'); } }), /Host migration failed/);
  allowed = false; const denied = await post('docs/history', { dataset: 'prod', id: 'one' });
  assert.equal(denied.error.code, 'PERMISSION_DENIED'); assert.equal(denied.result, undefined);
  console.log('Installed actual HTTP full revision history, bounded pages, bound cursors and denial passed', process.version);
} finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await db.close(); }
