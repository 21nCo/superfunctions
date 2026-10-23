// Run from a fresh normal install of the locally packed CMS and Content packages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCmsfnServer } from '@cmsfn/server';
import { createContentfnServer } from '@contentfn/server';
import { createContentfnClient } from '@contentfn/client';
import { memoryAdapter } from '@superfunctions/db/adapters';
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
const db = memoryAdapter();
const observed = []; const received = [];
const receiver = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; received.push({ url: req.url, body }); res.writeHead(204); res.end(); });
const destination = `${await listen(receiver)}/hook?token=delivery-only#fragment`;
const content = createContentfnServer({ db, webhookAuditWriterSchemaVersion: 4,
  context: request => ({ credential: request.headers.get('authorization'), subject: request.headers.get('x-subject') }),
  authorize: (context, action, input) => !action.startsWith('audit.') || (context?.credential === 'Bearer service' && context.subject === 'cms-auditor' && input.dataset === 'prod'),
});
const upstream = createServer((req, res) => { observed.push({ url: req.url, credential: req.headers.authorization }); void content.handler(req, res); });
const config = { contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: 'prod' }], desk: { kind: 'divider' }, auth: { kind: 'custom' },
  getRolesForSubject: async () => [{ id: 'auditor', name: 'Auditor', rules: [{ datasets: ['prod'], types: '*', actions: ['audit.read'] }] }],
  contentfnAuditHeaders: () => ({ authorization: 'Bearer service', 'x-subject': 'cms-auditor' }),
};
const cms = createCmsfnServer(config);
try {
  unwrap(await content.api.datasets.create({ dataset: 'prod' }));
  unwrap(await content.api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } }));
  const hook = unwrap(await content.api.webhooks.register({ dataset: 'prod', url: destination, events: ['doc.created'], secret: 'signing-secret' }));
  for (let n = 0; n < 105; n++) unwrap(await content.api.docs.create({ dataset: 'prod', id: `post-${n}`, type: 'post', doc: { title: 'private document body' } }));
  const queued = await db.findMany({ model: 'contentfn_webhook_queue', where: [], limit: 1 });
  await db.updateMany({ model: 'contentfn_webhook_queue', where: [{ field: 'id', operator: 'eq', value: queued[0].id }], data: { lastError: 'provider private-document https://example.test/?token=legacy-secret' } });
  const client = createContentfnClient({ baseUrl: config.contentfn.baseUrl, headers: config.contentfnAuditHeaders() });
  const expected = unwrap(await client.audit.webhooks({ dataset: 'prod', limit: 1000 })).records;
  assert.equal(expected.length, 105);
  assert.doesNotMatch(JSON.stringify(expected), /private-document|legacy-secret/);
  assert.ok(expected.some(row => row.lastError === "Webhook delivery failed"));
  const base = await listen(cms);
  const post = async body => (await fetch(`${base}/cmsfn/audit/webhooks`, { method: 'POST', headers: { authorization: 'Bearer browser' }, body: JSON.stringify(body) })).json();
  const deliveries = []; let cursor = null; let pages = 0;
  do {
    const result = unwrap(await post({ dataset: 'prod', limit: 40, cursor }));
    deliveries.push(...result.deliveries); cursor = result.nextCursor;
    assert.ok(++pages <= 3);
  } while (cursor !== null);
  assert.equal(pages, 3); assert.equal(deliveries.length, 105);
  assert.deepEqual(deliveries.map(row => row.eventId), expected.map(row => row.eventId));
  assert.ok(deliveries.every(row => row.status === 'pending' && row.attempt === 0 && row.timestampKnown && row.updatedAt && row.url === destination.split('?')[0]));
  assert.doesNotMatch(JSON.stringify(deliveries), /private document body|delivery-only|signing-secret|private-document|legacy-secret/);
  assert.deepEqual(await content.processWebhookQueue(), { delivered: 105, failed: 0 });
  assert.equal(received.length, 105); assert.ok(received.every(row => row.url === '/hook?token=delivery-only'));
  assert.ok(received.every(row => !row.body.includes('private document body')));
  const completed = unwrap(await post({ dataset: 'prod', limit: 1000 })).deliveries;
  assert.ok(completed.every(row => row.status === 'delivered' && row.attempt === 1 && row.timestampKnown));
  unwrap(await content.api.webhooks.delete({ dataset: 'prod', webhookId: hook.webhookId }));
  assert.equal(unwrap(await post({ dataset: 'prod', limit: 1000 })).deliveries.length, 105, 'deleted-hook history is retained');
  assert.equal((await client.webhooks.deliveries({ dataset: 'prod', webhookId: hook.webhookId })).ok, false, 'private per-hook boundary is unchanged');
  const before = observed.length;
  assert.equal((await post({ dataset: 'other' })).error.code, 'PERMISSION_DENIED');
  config.getRolesForSubject = undefined;
  assert.equal((await post({ dataset: 'prod' })).error.code, 'PERMISSION_DENIED');
  assert.equal(observed.length, before);
  config.getRolesForSubject = async () => [{ id: 'auditor', name: 'Auditor', rules: [{ datasets: ['prod'], types: '*', actions: ['audit.read'] }] }];
  config.contentfnAuditHeaders = undefined;
  assert.equal((await post({ dataset: 'prod' })).error.code, 'PERMISSION_DENIED');
  assert.equal(observed.at(-1).credential, undefined);
  config.contentfnAuditHeaders = () => ({ authorization: 'Bearer service', 'x-subject': 'cms-auditor' });
  unwrap(await content.api.datasets.delete({ dataset: 'prod' }));
  assert.equal(unwrap(await post({ dataset: 'prod' })).deliveries.length, 0, 'dataset deletion removes retained delivery history');
  console.log('Installed CMS → real ContentFn schema4 HTTP: 105 deliveries/3 pages, actual local signed delivery, safe URLs, deleted-hook retention, dataset deletion, trusted identity and deny boundaries passed.');
} finally {
  for (const server of [cms, upstream, receiver]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
