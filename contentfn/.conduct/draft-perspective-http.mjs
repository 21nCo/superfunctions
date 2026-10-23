import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createContentfnServer } from '@contentfn/server';
import { createContentfnClient } from '@contentfn/client';
import { memoryAdapter } from '@superfunctions/db/adapters';
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
const db = memoryAdapter();
const content = createContentfnServer({ db, authorize: (context, action, input) => context === 'setup' || (input.dataset === 'prod' && (context instanceof Request && context.headers.get('authorization') === 'Bearer editor' || action === 'query')) });
const setup = content.forContext('setup');
let server;
try {
  for (const dataset of ['prod', 'other']) {
    unwrap(await setup.datasets.create({ dataset }));
    unwrap(await setup.schema.upsert({ dataset, schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } }));
    for (const id of ['a', 'b', 'c']) unwrap(await setup.docs.create({ dataset, id, type: 'post', doc: { title: id } }));
  }
  server = createServer((req, res) => void content.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const editor = createContentfnClient({ baseUrl, headers: { authorization: 'Bearer editor' } });
  const guest = createContentfnClient({ baseUrl });
  assert.equal(unwrap(await guest.docs.query({ dataset: 'prod' })).data.length, 3);
  assert.equal((await guest.docs.query({ dataset: 'prod', perspective: 'draft' })).error.code, 'PERMISSION_DENIED');
  const source = unwrap(await editor.docs.get({ dataset: 'prod', id: 'a' }));
  assert.equal((await guest.docs.fork({ dataset: 'prod', id: 'a', ifRev: source._rev })).error.code, 'PERMISSION_DENIED');
  assert.equal((await editor.docs.fork({ dataset: 'prod', id: 'a', ifRev: 'stale' })).error.code, 'REV_CONFLICT');
  for (const id of ['a', 'b']) {
    const published = unwrap(await editor.docs.get({ dataset: 'prod', id }));
    const forked = unwrap(await editor.docs.fork({ dataset: 'prod', id, ifRev: published._rev }));
    assert.equal(forked._id, `drafts.${id}`); assert.notEqual(forked._rev, published._rev); assert.equal(forked._publishedAt, undefined);
    assert.deepEqual(unwrap(await editor.docs.get({ dataset: 'prod', id })), published);
    assert.equal((await editor.docs.fork({ dataset: 'prod', id, ifRev: published._rev })).error.code, 'DOCUMENT_ALREADY_EXISTS');
  }
  const query = { dataset: 'prod', perspective: 'draft', orderBy: [{ field: '_id', direction: 'asc' }], limit: 1 };
  const first = unwrap(await editor.docs.query(query));
  assert.deepEqual(first.data.map(doc => doc._id), ['drafts.a']);
  assert.deepEqual(unwrap(await editor.docs.query({ ...query, cursor: first.nextCursor })).data.map(doc => doc._id), ['drafts.b']);
  assert.equal((await editor.docs.query({ ...query, perspective: 'published', cursor: first.nextCursor })).error.code, 'QUERY_INVALID');
  assert.equal((await setup.docs.query({ ...query, dataset: 'other', cursor: first.nextCursor })).error.code, 'QUERY_INVALID');
  const invalid = await fetch(`${baseUrl}/contentfn/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer editor' }, body: JSON.stringify({ dataset: 'prod', perspective: 'raw' }) });
  assert.equal((await invalid.json()).error.code, 'QUERY_INVALID');
  assert.equal(unwrap(await editor.audit.query({ dataset: 'prod', action: 'docs.fork' })).records.length, 2);
  console.log('Packed ContentFn HTTP: separate perspective auth/pagination, source-CAS fork, collision, system fields, audit passed');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
