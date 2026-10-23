// Run from an isolated directory with current CmsFn and ContentFn tarballs installed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCmsfnServer } from '@cmsfn/server';
import { createContentfnServer } from '@contentfn/server';
import { createContentfnClient } from '@contentfn/client';
import { memoryAdapter } from '@superfunctions/db/adapters';
const db = memoryAdapter();
const seen = [];
const content = createContentfnServer({ db,
  context: request => ({ subject: request.headers.get('x-subject'), credential: request.headers.get('authorization') }),
  authorize: (context, action, input) => action !== 'audit.query' || (context?.credential === 'Bearer service' && context.subject === 'cms-auditor' && input.dataset === 'prod'),
});
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
const upstream = createServer((req, res) => { seen.push({ url: req.url, authorization: req.headers.authorization, subject: req.headers['x-subject'] }); void content.handler(req, res); });
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
const config = { contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' },
  getRolesForSubject: async () => [{ id: 'auditor', name: 'Auditor', rules: [{ datasets: ['prod'], types: '*', actions: ['audit.read'] }] }],
  contentfnAuditHeaders: () => ({ authorization: 'Bearer service', 'x-subject': 'cms-auditor' }),
};
const cms = createCmsfnServer(config);
try {
  const writer = content.forContext({ subject: 'original-author' });
  unwrap(await writer.datasets.create({ dataset: 'prod' }));
  unwrap(await writer.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } }));
  for (const id of ['first', 'second', 'third']) unwrap(await writer.docs.create({ dataset: 'prod', id, type: 'post', doc: { title: 'private document body' } }));
  const client = createContentfnClient({ baseUrl: config.contentfn.baseUrl, headers: config.contentfnAuditHeaders() });
  const expected = unwrap(await client.audit.query({ dataset: 'prod', order: 'desc', limit: 100 })).records;
  const base = await listen(cms);
  const post = async body => (await fetch(`${base}/cmsfn/audit/events`, { method: 'POST', headers: { authorization: 'Bearer browser' }, body: JSON.stringify(body) })).json();
  const events = []; let cursor = null, pages = 0;
  do {
    const result = unwrap(await post({ dataset: 'prod', limit: 2, cursor }));
    events.push(...result.events); cursor = result.nextCursor;
    assert.ok(++pages <= 3, 'pagination must terminate');
  } while (cursor !== null);
  assert.equal(pages, 3);
  assert.deepEqual(events.map(event => event.eventId), expected.map(record => record.id));
  assert.deepEqual(events.map(event => event.type), expected.map(record => record.action));
  assert.deepEqual(events.map(event => event.targetIds), expected.map(record => record.targetIds));
  assert.ok(events.every(event => event.actor.subject === 'original-author' && event.document === undefined && event.diff === undefined));
  assert.ok(!JSON.stringify(events).includes('private document body'));
  assert.ok(seen.every(row => row.url === '/contentfn/audit/query' && row.authorization === 'Bearer service' && row.subject === 'cms-auditor'));
  const before = seen.length;
  assert.equal((await post({ dataset: 'other' })).error.code, 'PERMISSION_DENIED');
  config.getRolesForSubject = undefined;
  assert.equal((await post({ dataset: 'prod' })).error.code, 'PERMISSION_DENIED');
  assert.equal(seen.length, before);
  config.getRolesForSubject = async () => [{ id: 'auditor', name: 'Auditor', rules: [{ datasets: ['prod'], types: '*', actions: ['audit.read'] }] }];
  config.contentfnAuditHeaders = undefined;
  const denied = await post({ dataset: 'prod' });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(seen.at(-1).authorization, undefined, 'browser credential must not be forwarded');
  const webhook = await fetch(`${base}/cmsfn/audit/webhooks`, { method: 'POST', body: JSON.stringify({ dataset: 'prod' }) });
  assert.equal((await webhook.json()).ok, false, 'webhook audit without schema4 acknowledgement must not manufacture an empty successful page');
  console.log('Installed CMS audit → real authorized ContentFn schema3 query: descending pages/targets/actor, dataset and role denials, trusted headers, upstream denial, unconfigured webhook error passed.');
} finally {
  for (const server of [cms, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
