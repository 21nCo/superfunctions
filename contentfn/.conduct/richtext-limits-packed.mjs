import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createContentfnServer } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const db = memoryAdapter();
const content = createContentfnServer({ db, limits: { maxRichtextBlocks: 2 } });
const http = createServer(content.handler);
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
try {
  const base = `http://127.0.0.1:${http.address().port}`;
  const post = async (path, input) => (await fetch(base + '/contentfn/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json();
  const blocks = n => Array.from({ length: n }, (_, i) => ({ _type: 'block', _key: `b${i}`, children: [{ _type: 'span', _key: `s${i}`, text: 'Text', marks: ['strong'] }], markDefs: [] }));
  unwrap(await post('datasets/create', { dataset: 'prod' }));
  unwrap(await post('schema/upsert', { dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'items', type: { kind: 'array', of: [{ kind: 'object', fields: [{ name: 'body', type: { kind: 'richtext', allowMarks: ['strong'] } }] }] } }] }] } }));
  const status = unwrap(await (await fetch(base + '/contentfn/status')).json()); assert.equal(status.limits.maxRichtextBlocks, 2);
  const failed = await post('docs/create', { dataset: 'prod', id: 'large', type: 'post', doc: { items: [{ body: blocks(3) }] } });
  assert.equal(failed.error.code, 'VALIDATION_FAILED'); assert.equal(failed.error.details.path, 'items[0].body');
  const created = unwrap(await post('docs/create', { dataset: 'prod', id: 'one', type: 'post', asDraft: true, doc: { items: [{ body: blocks(2) }] } }));
  const patched = await post('docs/patch', { dataset: 'prod', id: created._id, ifRev: created._rev, ops: [{ op: 'set', path: 'items', value: [{ body: blocks(3) }] }] });
  assert.equal(patched.error.code, 'VALIDATION_FAILED');
  assert.equal(unwrap(await post('docs/get', { dataset: 'prod', id: created._id, perspective: 'draft' }))._rev, created._rev);
  const artifact = unwrap(await post('datasets/export', { dataset: 'prod' })).artifact;
  artifact.draftDocs[0].items[0].body = blocks(3);
  assert.equal((await post('datasets/import', { dataset: 'copy', artifact })).error.code, 'VALIDATION_FAILED');
  assert.deepEqual(unwrap(await post('datasets/list', {})).datasets, ['prod']);
  assert.deepEqual(unwrap(await post('docs/publish', { dataset: 'prod', id: 'one', ifRev: created._rev })).items[0].body, blocks(2));
  console.log('Installed HTTP richtext configured boundary, nested path, rollback, canonical marks and publication passed', process.version);
} finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await db.close(); }
