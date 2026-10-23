// Execute in a normally installed consumer containing packed Studio and producer packages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createContentfnServer, InMemoryStorageBackend } from '@contentfn/server';
import { createCmsfnServer, verifyPreviewToken } from '@cmsfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters';
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
const db = memoryAdapter();
const cmsDb = memoryAdapter();
const assetStorage = new InMemoryStorageBackend();
const previewSecret = 'fixture-preview-secret-32-bytes-minimum';
let allowPreview = true; let deniedMediaDataset = ''; let allowReferences = true;
let denySingletonReads = false; let denyHistory = false;
const content = createContentfnServer({ db, storage: assetStorage, maxPayloadBytes: 16, limits: { maxRichtextBlocks: 3 }, context: request => Object.assign(request, { subject: request.headers.get('authorization') === 'Bearer fixture-release-service' ? 'scheduler' : undefined }), webhookAuditWriterSchemaVersion: 4, authorize: (context, action, input) => context instanceof Request && action.startsWith('assets.') && input.dataset === deniedMediaDataset ? false : context instanceof Request && action === 'query' && Array.isArray(input.types) && input.types.includes('author') ? context.headers.get('authorization') === 'Bearer fixture-reference-service' : action === 'realtime.subscribe' ? context instanceof Request && context.headers.get('cookie')?.includes('fixture_session=preview') === true : context instanceof Request && ['datasets.export', 'datasets.import'].includes(action) ? context.headers.get('authorization') === 'Bearer fixture-ops-service' : !(denyHistory && action === 'docs.history') && !(denySingletonReads && context instanceof Request && action === 'docs.get' && String(input.id).replace(/^drafts\./, '') === 'private-home') });
const richtextType = { kind: 'richtext', allowMarks: ['strong', 'link'], allowObjects: ['asset'] };
const arrayObjectType = { kind: 'object', fields: [{ name: 'body', type: richtextType }, { name: 'caption', type: { kind: 'primitive', type: 'string' } }, { name: 'literal.asset', type: { kind: 'asset', assetType: 'file' } }, { name: 'author', type: { kind: 'reference', to: ['author'] } }] };
const schema = { version: 1, documentTypes: ['post', 'page', 'author'].map(name => ({ name, fields: [{ name: 'title', required: true, type: { kind: 'primitive', type: 'string' } }, ...(name === 'post' ? [{ name: 'body', type: richtextType }, { name: 'items', type: { kind: 'array', of: [arrayObjectType], maxLength: 3 } }, { name: 'links', type: { kind: 'array', of: [{ kind: 'reference', to: ['author'] }] } }, { name: 'files', type: { kind: 'array', of: [{ kind: 'asset', assetType: 'file' }] } }, { name: 'media', type: { kind: 'object', fields: [{ name: 'caption', type: { kind: 'primitive', type: 'string' } }, { name: 'attachment', type: { kind: 'asset', assetType: 'file' } }, { name: 'author', type: { kind: 'reference', to: ['author'] } }] } }] : [])] })) };
for (const dataset of ['prod', 'staging']) {
  unwrap(await content.api.datasets.create({ dataset }));
  unwrap(await content.api.schema.upsert({ dataset, schema }));
  for (const asDraft of [false, true]) unwrap(await content.api.docs.create({ dataset, id: 'home', type: 'page', doc: { title: `${dataset} home` }, asDraft }));
}
unwrap(await content.api.docs.create({ dataset: 'prod', id: 'private-home', type: 'page', doc: { title: 'Confidential singleton body' }, asDraft: true }));
// Paired draft/published document exercises the current supported editor path.
for (const asDraft of [false, true]) unwrap(await content.api.docs.create({ dataset: 'prod', id: 'editable', type: 'post', doc: { title: 'Original title' }, asDraft }));
unwrap(await content.api.docs.create({ dataset: 'prod', id: 'published-only', type: 'post', doc: { title: 'Published only' } }));
unwrap(await content.api.docs.create({ dataset: 'prod', id: 'draft-only', type: 'post', doc: { title: 'Draft only' }, asDraft: true }));
unwrap(await content.api.docs.create({ dataset: 'staging', id: 'staging-post', type: 'post', doc: { title: 'Staging' } }));
// Register an inert destination; this fixture inspects queued metadata without sending.
const auditHook = unwrap(await content.api.webhooks.register({ dataset: 'prod', url: 'https://example.invalid/hook?token=never-render', events: ['doc.created'], secret: 'never-render-signing' }));
for (let n = 0; n < 25; n++) unwrap(await content.api.docs.create({ dataset: 'prod', id: `audit-${n}`, type: 'page', doc: { title: 'Never render audit document body' } }));
await writeFile('studio-entry.mjs', `import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from '@cmsfn/studio'; createRoot(document.getElementById('root')).render(React.createElement(App));`);
await build({ entryPoints: ['studio-entry.mjs'], outfile: 'studio-bundle.js', bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
const bundle = await readFile('studio-bundle.js');
let base = ''; let cmsBase = ''; let cms; let statusMode = 'normal'; let allowPublish = true; let allowAudit = true; let allowReleases = true; let allowMigration = false;
const requests = []; const scheduledKeys = []; let dropScheduledAck = false;
const server = createServer((req, res) => {
  if (req.url?.startsWith('/cmsfn/')) { requests.push(req.url); cms.emit('request', req, res); return; }
  if (req.url === '/contentfn/status' && statusMode !== 'normal') {
    requests.push(req.url); res.setHeader('content-type', 'application/json');
    if (statusMode === 'outage') { res.writeHead(503); res.end('{}'); }
    else res.end(JSON.stringify({ ok: true, result: { serverTime: new Date().toISOString(), capabilities: ['content.docs'] } }));
    return;
  }
  if (req.url?.startsWith('/contentfn/')) { if (req.url === '/contentfn/docs/publish' && req.headers['idempotency-key']) { scheduledKeys.push(req.headers['idempotency-key']); if (dropScheduledAck) { dropScheduledAck = false; res.end = () => { res.destroy(); return res; }; } } requests.push(req.url); void content.handler(req, res); return; }
  if (req.url?.startsWith('/preview?')) {
    const url = new URL(req.url, base); const dataset = url.searchParams.get('dataset'); const docId = url.searchParams.get('docId');
    if (!dataset || !docId || !verifyPreviewToken(previewSecret, url.searchParams.get('cmsfn_preview_token') ?? '', { audience: base, dataset, docId })) { res.writeHead(403); res.end('Denied'); return; }
    void content.api.docs.get({ dataset, id: docId, perspective: 'draft' }).then(result => {
      if (!result.ok) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
      res.end('<p data-preview-title>' + String(result.result.title).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</p>');
    }); return;
  }
  if (req.url === '/studio-bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
  if (req.url?.startsWith('/studio')) {
    const config = { limits: { maxUploadBytes: 16, maxRichtextBlocks: 3 }, contentfn: { baseUrl: base }, cmsfn: { apiUrl: cmsBase }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'group', title: 'Content', children: [{ kind: 'documentList', title: 'Posts', dataset: 'prod', types: ['post'] },
      { kind: 'singleton', title: 'Production home', dataset: 'prod', type: 'page', id: 'home' },
      { kind: 'singleton', title: 'Staging home', dataset: 'staging', type: 'page', id: 'home' },
      { kind: 'singleton', title: 'Private home', dataset: 'prod', type: 'page', id: 'private-home' },
      { kind: 'singleton', title: 'Missing home', dataset: 'prod', type: 'page', id: 'missing-home' },
      { kind: 'singleton', title: 'Wrong type home', dataset: 'prod', type: 'page', id: 'editable' },
      { kind: 'singleton', title: 'Unconfigured home', dataset: 'unconfigured', type: 'page', id: 'home' },
    ] } };
    const previewMode = new URL(req.url, base).searchParams.get('preview');
    if (previewMode) { config.preview = { enabled: true, targetOrigin: base }; config.contentfn.realtimeUrl = `${base}/contentfn/events`; }
    const resolver = previewMode ? `window.__CMSFN_CONFIG__.preview.resolveUrl = doc => ${JSON.stringify(previewMode === 'unsafe' ? 'https://example.invalid' : base)} + '/preview?dataset=' + encodeURIComponent(document.querySelector('[data-current-dataset]').getAttribute('data-current-dataset')) + '&docId=' + encodeURIComponent(doc._id);` : '';
    res.setHeader('set-cookie', 'fixture_session=preview; HttpOnly; SameSite=Strict; Path=/');
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><body><div id="root"></div>${req.url.includes('empty') ? '' : `<script>window.__CMSFN_CONFIG__=${JSON.stringify(config)};${resolver}</script>`}<script type="module" src="/studio-bundle.js"></script></body></html>`); return;
  }
  res.writeHead(204); res.end();
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  cms = createCmsfnServer({ contentfnReferenceHeaders: () => ({ authorization: 'Bearer fixture-reference-service' }), previewSecret, previewTokenTtlSec: 8, preview: { enabled: true, targetOrigin: base, resolveUrl: () => base }, db: cmsDb, releaseExecutionSchemaVersion: 2, resolveReleaseExecutionIdentity: async () => ({ subject: 'scheduler', headers: { authorization: 'Bearer fixture-release-service' }, roles: [{ id: 'service', name: 'Service', rules: [{ datasets: ['prod', 'staging'], types: '*', actions: ['release.manage', 'doc.publish'] }] }] }), contentfnOpsHeaders: () => ({ authorization: 'Bearer fixture-ops-service' }), authorizeCrossDatasetImport: async (_req, input) => allowMigration && input.sourceDataset === 'prod' && input.targetDataset === 'staging', contentfn: { baseUrl: base }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'divider' }, getRolesForSubject: async () => [{ id: 'editor', name: 'Editor', rules: [...(allowPreview ? [{ datasets: ['prod', 'staging'], types: '*', actions: ['doc.read'] }] : []), ...(allowReferences ? [{ datasets: ['prod'], types: ['author'], actions: ['doc.read'] }] : []), ...(allowPublish ? [{ datasets: ['prod'], types: '*', actions: ['doc.publish', 'doc.unpublish'] }] : []), ...(allowAudit ? [{ datasets: ['prod', 'staging'], types: '*', actions: ['audit.read'] }] : []), ...(allowReleases ? [{ datasets: ['prod', 'staging'], types: '*', actions: ['release.manage'] }] : [])] }] });
  await new Promise(resolve => cms.listen(0, '127.0.0.1', resolve));
  unwrap(await cms.readiness);
  cmsBase = base; // Host serves both APIs under its own origin, as a normal reverse proxy would.
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio?empty=1`);
  await page.locator('[data-studio-state="no-config"]').waitFor();
  await page.goto(`${base}/studio`);
  await page.locator('[data-studio-state="ready"]').waitFor();
  assert.equal(await page.locator('[data-current-dataset]').getAttribute('data-current-dataset'), 'prod');
  await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.draft-only"]').waitFor();
  assert.equal(await page.locator('[data-doc-id="published-only"]').count(), 0);
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  const title = page.locator('input[data-field-path="title"]');
  await title.waitFor(); assert.equal(await title.inputValue(), 'Original title');
  await title.fill('Saved through installed Studio');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' })).title, 'Saved through installed Studio');
  const draft = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ifRev: draft._rev, ops: [{ op: 'set', path: 'title', value: 'Concurrent edit' }] }));
  await title.fill('Local stale edit'); await page.locator('[data-editor-save]').click();
  await page.locator('[data-conflict-banner]').waitFor();
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' })).title, 'Concurrent edit');
  await page.locator('[data-conflict-refresh]').click();
  await page.waitForFunction(() => document.querySelector('input[data-field-path="title"]')?.value === 'Concurrent edit');
  // Full real revision pages, including content snapshots and authorization revocation.
  for (let index = 0; index < 22; index++) unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ops: [{ op: 'set', path: 'title', value: `History value ${index}` }] }));
  const expectedHistory = unwrap(await content.api.docs.history({ dataset: 'prod', id: 'editable', limit: 20 }));
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('[data-history-revision]').first().waitFor();
  assert.deepEqual(await page.locator('[data-history-revision]').evaluateAll(rows => rows.map(row => row.getAttribute('data-history-revision'))), expectedHistory.revisions.map(row => row._rev));
  assert.equal(JSON.parse(await page.locator('[data-history-revision] pre').first().textContent()).title, expectedHistory.revisions[0].title);
  await page.getByRole('button', { name: 'Older revisions' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-history-revision]').length > 0 && document.querySelectorAll('[data-history-revision]').length < 20);
  assert.ok((await page.locator('[data-history-content]').textContent()).includes('Original title'));
  denyHistory = true; await page.getByRole('button', { name: 'Refresh history' }).click();
  await page.getByText('No access to document history.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-history-revision]').count(), 0); denyHistory = false;
  await page.locator('[data-editor-back]').click();
  await page.getByRole('combobox', { name: 'Document perspective' }).selectOption('published');
  await page.locator('[data-doc-id="published-only"] [data-doc-open]').click();
  await page.getByRole('heading', { name: 'Published document' }).waitFor();
  assert.equal(await page.locator('[data-editor-save]').count(), 0);
  const published = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'published-only' }));
  unwrap(await content.api.docs.patch({ dataset: 'prod', id: published._id, ifRev: published._rev, ops: [{ op: 'set', path: 'title', value: 'Changed published source' }] }));
  await page.locator('[data-create-draft]').click();
  await page.locator('[data-fork-error]').waitFor();
  assert.equal((await content.api.docs.get({ dataset: 'prod', id: 'published-only', perspective: 'draft' })).ok, false);
  await page.locator('[data-published-refresh]').click();
  await page.getByText('Changed published source', { exact: true }).waitFor();
  await page.locator('[data-create-draft]').click();
  await page.getByRole('heading', { name: 'Draft document' }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[data-field-path="title"]')?.value === 'Changed published source');
  await page.locator('[data-workflow-state="approved"]').click();
  await page.locator('[data-workflow-controls][data-current-state="approved"]').waitFor();
  const [firstPublishResponse] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/cmsfn/publish')), page.locator('[data-publish-button]').click()]);
  unwrap(await firstPublishResponse.json());
  await page.waitForFunction(() => !document.querySelector('[data-editor-pane][data-loading]') && !!document.querySelector('[data-unpublish-button]'));
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'published-only' })).title, 'Changed published source');
  await title.fill('Republished draft');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  allowPublish = false;
  await page.locator('[data-publish-button]').click();
  await page.locator('[data-publish-error]').waitFor();
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'published-only' })).title, 'Changed published source');
  allowPublish = true;
  const [republishResponse] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/cmsfn/publish')), page.locator('[data-publish-button]').click()]);
  unwrap(await republishResponse.json());
  await page.waitForFunction(() => !document.querySelector('[data-editor-pane][data-loading]') && !!document.querySelector('[data-unpublish-button]'));
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'published-only' })).title, 'Republished draft');
  await page.locator('[data-unpublish-button]').click();
  await page.waitForFunction(() => !document.querySelector('[data-editor-pane][data-loading]') && !!document.querySelector('[data-publish-button]') && !document.querySelector('[data-unpublish-button]'));
  assert.equal((await content.api.docs.get({ dataset: 'prod', id: 'published-only' })).ok, false);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'published-only', perspective: 'draft' })).title, 'Republished draft');
  await page.locator('[data-editor-back]').click();
  await page.getByRole('combobox', { name: 'Document perspective' }).selectOption('published');
  await page.locator('[data-doc-id="editable"] [data-doc-open]').click();
  const winningDraft = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  await page.locator('[data-create-draft]').click();
  await page.waitForFunction(expected => document.querySelector('input[data-field-path="title"]')?.value === expected, winningDraft.title);
  assert.deepEqual(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' })), winningDraft);
  await page.getByRole('combobox', { name: /select dataset/i }).selectOption('staging');
  assert.equal(await page.locator('[data-editor-pane]').count(), 0);
  await page.getByRole('combobox', { name: 'Document perspective' }).selectOption('published');
  await page.locator('[data-doc-id="staging-post"]').waitFor();
  assert.equal(await page.locator('[data-doc-id="editable"]').count(), 0);
  await page.getByRole('button', { name: 'Production home', exact: true }).click();
  await page.getByRole('heading', { name: 'Published document' }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Select dataset' }).inputValue(), 'prod');
  await page.getByText('prod home', { exact: true }).waitFor();
  await page.locator('[data-create-draft]').click();
  await page.waitForFunction(() => document.querySelector('input[data-field-path="title"]')?.value === 'prod home');
  await title.fill('Production home edit');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' })).title, 'Production home edit');
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' })).title, 'staging home');
  await page.getByRole('button', { name: 'History', exact: true }).click(); await page.locator('[data-history-revision]').first().waitFor();
  assert.ok((await page.locator('[data-history-content]').textContent()).includes('Production home edit'));
  await page.getByRole('button', { name: 'Staging home', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[data-field-path="title"]')?.value === 'staging home');
  assert.equal(await page.getByRole('combobox', { name: 'Select dataset' }).inputValue(), 'staging');
  assert.equal(await page.locator('[data-history-revision]').count(), 0);
  await page.getByRole('button', { name: 'History', exact: true }).click(); await page.locator('[data-history-revision]').first().waitFor();
  assert.ok(!(await page.locator('[data-history-content]').textContent()).includes('Production home edit'));
  assert.ok((await page.locator('[data-history-content]').textContent()).includes('staging home'));
  await page.getByRole('button', { name: 'History', exact: true }).click();

  await title.fill('Staging home edit');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' })).title, 'Staging home edit');
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' })).title, 'Production home edit');
  denySingletonReads = true;
  await page.getByRole('button', { name: 'Private home', exact: true }).click();
  await page.locator('[data-editor-pane][data-error-code="PERMISSION_DENIED"]').waitFor();
  assert.equal(await page.locator('[data-editor-save]').count(), 0);
  assert.equal((await page.textContent('body')).includes('Confidential singleton body'), false);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'private-home', perspective: 'draft' })).title, 'Confidential singleton body');
  const beforeMissing = requests.length;
  await page.getByRole('button', { name: 'Missing home', exact: true }).click();
  await page.locator('[data-editor-pane][data-error-code="DOCUMENT_NOT_FOUND"]').waitFor();
  assert.equal(requests.slice(beforeMissing).some(path => /\/(fork|create|patch)$/.test(path)), false);
  await page.getByRole('button', { name: 'Wrong type home', exact: true }).click();
  await page.getByText('Document type does not match this desk singleton', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-editor-save]').count(), 0);
  const beforeUnavailable = requests.length;
  await page.getByRole('button', { name: 'Unconfigured home', exact: true }).click();
  await page.locator('[data-desk-error]').waitFor();
  assert.equal(requests.length, beforeUnavailable);
  await page.getByRole('button', { name: 'Audit events', exact: true }).click();
  await page.locator('[data-audit-event]').first().waitFor();
  assert.equal(await page.locator('[data-audit-event]').count(), 20);
  const firstEventIds = await page.locator('[data-audit-event]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-event-id')));
  await page.locator('[data-audit-events-load-more]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-audit-event]').length === 40);
  const eventIds = await page.locator('[data-audit-event]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-event-id')));
  assert.equal(new Set(eventIds).size, 40); assert.deepEqual(eventIds.slice(0, 20), firstEventIds);
  while (await page.locator('[data-audit-events-load-more]').count()) {
    await page.locator('[data-audit-events-load-more]').click();
    await page.waitForFunction(() => !document.querySelector('[data-audit-events-load-more]')?.disabled);
  }
  const allEvents = await page.locator('[data-audit-event]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-event-id')));
  const expectedEvents = unwrap(await content.api.audit.query({ dataset: 'prod', limit: 1000, order: 'desc' })).records;
  assert.deepEqual(allEvents, expectedEvents.map(row => row.id));

  assert.equal((await page.textContent('body')).includes('Never render audit document body'), false);
  await page.getByRole('button', { name: 'Webhook deliveries', exact: true }).click();
  await page.locator('[data-audit-delivery]').first().waitFor(); assert.equal(await page.locator('[data-audit-delivery]').count(), 20);
  await page.locator('[data-audit-webhooks-load-more]').click();
  const expectedDeliveries = unwrap(await content.api.audit.webhooks({ dataset: 'prod', limit: 1000, order: 'desc' })).records;
  await page.waitForFunction(count => document.querySelectorAll('[data-audit-delivery]').length === count, expectedDeliveries.length);
  assert.deepEqual(await page.locator('[data-audit-delivery-event]').allTextContents(), expectedDeliveries.map(row => row.eventId));
  assert.ok((await page.locator('[data-audit-delivery-webhook]').allTextContents()).every(id => id === auditHook.webhookId));
  assert.doesNotMatch(await page.textContent('body'), /never-render|Never render audit document body/);
  await page.getByRole('combobox', { name: 'Select dataset' }).selectOption('staging');
  await page.waitForFunction(() => document.querySelector('[data-audit-webhooks-pane]')?.getAttribute('data-dataset') === 'staging' && !document.querySelector('[data-audit-webhooks-loading]'));
  assert.equal(await page.locator('[data-audit-delivery]').count(), 0);
  await page.getByRole('combobox', { name: 'Select dataset' }).selectOption('prod'); await page.locator('[data-audit-delivery]').first().waitFor();
  allowAudit = false; await page.locator('[data-audit-webhooks-refresh]').click(); await page.locator('[data-audit-denied]').waitFor(); assert.equal(await page.locator('[data-audit-delivery]').count(), 0);
  await page.getByRole('button', { name: 'Audit events', exact: true }).click(); await page.locator('[data-audit-events-pane][data-audit-denied]').waitFor(); assert.equal(await page.locator('[data-audit-event]').count(), 0);
  for (const [id, state] of [['release-a', 'draft'], ['release-z', 'approved']]) unwrap(await content.api.docs.create({ dataset: 'prod', id, type: 'post', asDraft: true, doc: { title: id, _cms: { workflow: 'default', state } } }));
  await page.getByRole('button', { name: 'Releases', exact: true }).click(); await page.getByText('No releases.', { exact: true }).waitFor();
  await page.getByLabel('Release name', { exact: true }).fill('Browser batch'); await page.locator('[data-releases-create-submit]').click(); await page.getByRole('heading', { name: 'Browser batch', exact: true }).waitFor();
  for (const id of ['drafts.release-z', 'release-a', 'release-a']) {
    await page.getByLabel('Draft document ID for Browser batch').fill(id);
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/cmsfn/releases/add')), page.locator('[data-release-add]').click()]);
    await page.waitForFunction(() => !document.querySelector('[data-releases-refresh]')?.disabled);
  }
  assert.deepEqual(await page.locator('[data-release-document]').allTextContents(), ['release-a', 'release-z']);
  await page.locator('[data-releases-publish]').click(); await page.getByText('Published: 1', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('[data-release-published]').allTextContents(), ['release-z']);
  assert.match((await page.locator('[data-release-failure]').allTextContents()).join(''), /release-a: PERMISSION_DENIED/);
  assert.equal((await content.api.docs.get({ dataset: 'prod', id: 'release-a' })).ok, false);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'release-z' })).title, 'release-z');
  // Actual Studio schedule creation, host invocation and real producer committed-response loss.
  unwrap(await content.api.docs.create({ dataset: 'prod', id: 'scheduled-browser-doc', type: 'post', asDraft: true, doc: { title: 'Scheduled', _cms: { workflow: 'default', state: 'approved' } } }));
  await page.getByLabel('Release name', { exact: true }).fill('Scheduled browser');
  await page.getByLabel('Publish at (local time)', { exact: true }).fill('2020-01-01T12:00');
  await page.locator('[data-releases-create-submit]').click(); await page.getByRole('heading', { name: 'Scheduled browser', exact: true }).waitFor();
  const scheduledRow = page.locator('[data-releases-item]').filter({ has: page.getByRole('heading', { name: 'Scheduled browser', exact: true }) });
  const scheduledId = await scheduledRow.getAttribute('data-release-id');
  const keysBeforeEmpty = scheduledKeys.length;
  const emptySweep = await cms.executeDueReleases();
  assert.equal(emptySweep.results[0].outcome.error.code, 'VALIDATION_FAILED');
  const emptyRow = await cmsDb.findOne({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: scheduledId }] });
  assert.equal(emptyRow.execution, null);
  assert.equal(scheduledKeys.length, keysBeforeEmpty);
  await scheduledRow.locator('[data-release-doc-input]').fill('scheduled-browser-doc');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/cmsfn/releases/add')), scheduledRow.locator('[data-release-add]').click()]);
  await page.waitForFunction(() => !document.querySelector('[data-releases-refresh]')?.disabled);
  // Advance the empty-authoring backoff without creating or changing a journal.
  await cmsDb.updateMany({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: scheduledId }], data: { nextRunAt: new Date().toISOString() } });
  const auditBefore = unwrap(await content.api.audit.query({ dataset: 'prod', action: 'docs.publish', limit: 100 })).records.length;
  dropScheduledAck = true;
  const firstSweep = await cms.executeDueReleases();
  assert.equal(firstSweep.results.length, 1); assert.equal(firstSweep.results[0].outcome.result.execution.state, 'uncertain');
  assert.equal((await content.api.docs.get({ dataset: 'prod', id: 'drafts.scheduled-browser-doc' })).ok, false);
  await page.locator('[data-releases-refresh]').click(); await scheduledRow.getByText('Execution: uncertain', { exact: true }).waitFor();
  // Advance only this fixture's persisted retry due time, preserving the original journal/key/subject.
  await cmsDb.updateMany({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: scheduledId }], data: { nextRunAt: new Date().toISOString() } });
  const secondSweep = await cms.executeDueReleases();
  assert.deepEqual(secondSweep.results[0].outcome.result.published, ['scheduled-browser-doc']);
  assert.equal(scheduledKeys.at(-1), scheduledKeys.at(-2));
  assert.equal(unwrap(await content.api.audit.query({ dataset: 'prod', action: 'docs.publish', limit: 100 })).records.length, auditBefore + 1);
  await page.locator('[data-releases-refresh]').click(); await scheduledRow.getByText('Execution: complete', { exact: true }).waitFor();
  assert.deepEqual((await cms.executeDueReleases()).results, []);
  await page.getByRole('combobox', { name: 'Select dataset' }).selectOption('staging'); await page.getByText('No releases.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-releases-item]').count(), 0); assert.equal(await page.locator('[data-releases-publish-result]').count(), 0);
  await page.getByRole('combobox', { name: 'Select dataset' }).selectOption('prod'); await page.getByRole('heading', { name: 'Browser batch' }).waitFor();
  allowReleases = false; await page.locator('[data-releases-refresh]').click(); await page.locator('[data-releases-denied]').waitFor();
  assert.equal(await page.locator('[data-releases-item]').count(), 0); assert.equal(await page.locator('[data-releases-create-submit]').count(), 0);
  allowAudit = true;
  await page.getByRole('button', { name: 'Import / export', exact: true }).click(); await page.locator('[data-ops-pane]').waitFor();
  await page.locator('[data-ops-export-trigger]').click(); await page.locator('[data-ops-download]').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-ops-download]').click()]);
  const archiveText = await readFile(await download.path(), 'utf8'); const archive = JSON.parse(archiveText);
  assert.equal(archive.dataset, 'prod'); assert.ok(archiveText.length > 500); assert.deepEqual(JSON.parse(await page.locator('[data-ops-export-result]').inputValue()), archive);
  const sourceHome = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' }));
  unwrap(await content.api.docs.patch({ dataset: 'prod', id: sourceHome._id, ifRev: sourceHome._rev, ops: [{ op: 'set', path: 'title', value: 'Changed after export' }] }));
  await page.getByLabel('Artifact JSON').fill(archiveText); await page.locator('[data-ops-import-trigger]').click(); await page.locator('[data-ops-import-success]').waitFor();
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' })).title, sourceHome.title);
  const malformed = { ...archive, draftDocs: [archive.draftDocs[0], archive.draftDocs[0]] };
  await page.getByLabel('Artifact JSON').fill(JSON.stringify(malformed)); await page.locator('[data-ops-import-trigger]').click(); await page.getByText('Operation failed (VALIDATION_FAILED).', { exact: true }).waitFor();
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' })).title, sourceHome.title);
  await page.getByRole('combobox', { name: 'Select dataset' }).selectOption('staging'); assert.equal(await page.locator('[data-ops-download]').count(), 0);
  const targetBefore = unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' }));
  await page.getByLabel('Artifact JSON').fill(archiveText); await page.locator('[data-ops-import-trigger]').click(); await page.getByText('Operation failed (PERMISSION_DENIED).', { exact: true }).waitFor();
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' })).title, targetBefore.title);
  allowMigration = true; await page.locator('[data-ops-import-trigger]').click(); await page.getByText('Import completed for staging.', { exact: true }).waitFor();
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' })).title, sourceHome.title);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' })).title, sourceHome.title);
  allowAudit = false; await page.locator('[data-ops-export-trigger]').click(); await page.locator('[data-ops-denied]').waitFor(); assert.equal(await page.locator('[data-ops-download]').count(), 0);
  allowAudit = true;
  for (statusMode of ['incompatible', 'outage']) {
    const beforeCapabilityFailure = requests.length;
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/cmsfn/ops/export')), page.locator('[data-ops-export-trigger]').click()]); await page.getByText('Operation failed (CONTENTFN_UNAVAILABLE).', { exact: true }).waitFor();
    assert.deepEqual(requests.slice(beforeCapabilityFailure), ['/cmsfn/ops/export', '/contentfn/status']);
  }
  statusMode = 'incompatible';
  const incompatibleCms = createCmsfnServer({ contentfn: { baseUrl: base }, datasets: [], desk: { kind: 'divider' }, auth: { kind: 'custom' } });
  try {
    await new Promise(resolve => incompatibleCms.listen(0, '127.0.0.1', resolve));
    assert.equal((await incompatibleCms.readiness).error.code, 'CONTENTFN_UNAVAILABLE');
  } finally { incompatibleCms.closeAllConnections(); await new Promise(resolve => incompatibleCms.close(resolve)); }
  statusMode = 'normal'; await page.locator('[data-ops-export-trigger]').click(); await page.locator('[data-ops-download]').waitFor();
  // Full installed preview target with real cookie-authorized ContentFn SSE.
  assert.equal((await fetch(`${base}/contentfn/events?dataset=prod&docId=drafts.editable`)).status, 403);
  await page.goto(`${base}/studio?preview=1`);
  await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  const frame = page.frameLocator('[data-preview-iframe]');
  await frame.locator('[data-preview-title]').waitFor();
  await page.waitForFunction(() => !!document.querySelector('[data-preview-iframe]')?.getAttribute('src'));
  const tokenBefore = new URL(await page.locator('[data-preview-iframe]').getAttribute('src')).searchParams.get('cmsfn_preview_token');
  assert.ok(requests.some(path => path.includes('/contentfn/events') && path.includes('docId=drafts.editable')));
  unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ops: [{ op: 'set', path: 'title', value: 'Live SSE preview change' }] }));
  await frame.getByText('Live SSE preview change', { exact: true }).waitFor({ timeout: 2500 });
  await page.waitForFunction(previous => new URL(document.querySelector('[data-preview-iframe]').src).searchParams.get('cmsfn_preview_token') !== previous, tokenBefore);
  assert.equal((await fetch(`${base}/preview?dataset=staging&docId=editable&cmsfn_preview_token=${encodeURIComponent(tokenBefore)}`)).status, 403);
  assert.equal((await fetch(`${base}/preview?dataset=prod&docId=other&cmsfn_preview_token=${encodeURIComponent(tokenBefore)}`)).status, 403);
  allowPreview = false;
  await page.getByText('Failed to load a valid preview token.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-preview-iframe]').count(), 0);
  const tokenRequestsBeforeUnsafe = requests.filter(path => path === '/cmsfn/preview/token').length;
  await page.goto(`${base}/studio?preview=unsafe`);
  await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  await page.getByText('Preview URL must match the configured HTTP(S) origin and contain no credentials.', { exact: true }).waitFor();
  assert.equal(requests.filter(path => path === '/cmsfn/preview/token').length, tokenRequestsBeforeUnsafe);
  assert.equal(await page.locator('[data-preview-iframe]').count(), 0);
  // Entire installed media workflow: producer byte limits, bounded pages and nested persistence.
  const mediaInput = { dataset: 'prod', filename: 'exact.txt', contentType: 'text/plain', bytesBase64: Buffer.from('a').toString('base64') };
  unwrap(await content.api.assets.upload(mediaInput));
  unwrap(await content.api.assets.upload({ ...mediaInput, bytesBase64: Buffer.alloc(16).toString('base64') }));
  assert.equal((await content.api.assets.upload({ ...mediaInput, bytesBase64: Buffer.alloc(17).toString('base64') })).error.code, 'PAYLOAD_TOO_LARGE');
  for (let index = 0; index < 51; index++) unwrap(await content.api.assets.upload({ ...mediaInput, filename: `page-${index}.txt` }));
  const firstAssetPage = unwrap(await content.api.assets.list({ dataset: 'prod', limit: 50, offset: 0 }));
  await page.goto(`${base}/studio`); await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  await page.locator('[data-field-path="media.attachment"] [data-asset-open-media]').click();
  await page.locator('[data-media-item]').first().waitFor();
  assert.deepEqual(await page.locator('[data-media-item]').evaluateAll(rows => rows.map(row => row.getAttribute('data-asset-id'))), firstAssetPage.assets.map(asset => asset.assetId));
  await page.getByRole('button', { name: 'Next media page' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-media-item]').length === 3);
  const nextAssetPage = unwrap(await content.api.assets.list({ dataset: 'prod', limit: 50, offset: 50 }));
  assert.deepEqual(await page.locator('[data-media-item]').evaluateAll(rows => rows.map(row => row.getAttribute('data-asset-id'))), nextAssetPage.assets.map(asset => asset.assetId));
  const uploadRequestsBefore = requests.filter(path => path === '/contentfn/assets/upload').length;
  await page.getByLabel('Upload file').setInputFiles({ name: 'oversized.txt', mimeType: 'text/plain', buffer: Buffer.alloc(17) });
  await page.locator('[data-media-upload-error]').waitFor();
  assert.equal(requests.filter(path => path === '/contentfn/assets/upload').length, uploadRequestsBefore);
  // Editing a sibling while the picker is open must survive insertion.
  await page.locator('input[data-field-path="media.caption"]').fill('Keep this sibling');
  const [uploadResponse] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/assets/upload')), page.getByLabel('Upload file').setInputFiles({ name: '<script>safe-name.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })]);
  const uploaded = unwrap(await uploadResponse.json());
  assert.equal(assetStorage.getAsset(uploaded.url.replace('memory://', '')).bytes.toString(), 'hello');
  await page.locator(`[data-asset-id="${uploaded.assetId}"] [data-media-select]`).click();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.deepEqual(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' })).media, { caption: 'Keep this sibling', attachment: { _type: 'asset', _ref: uploaded.assetId, assetType: 'file' } });
  await page.locator('[data-field-path="media.attachment"] [data-asset-open-media]').click(); await page.locator('[data-media-item]').first().waitFor();
  deniedMediaDataset = 'prod'; await page.getByRole('button', { name: 'Refresh media' }).click();
  await page.locator('[data-media-denied]').waitFor(); assert.equal(await page.locator('[data-media-item]').count(), 0);
  assert.equal((await fetch(`${base}/contentfn/assets/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mediaInput) }).then(response => response.json())).error.code, 'PERMISSION_DENIED');
  deniedMediaDataset = '';
  // Navigation cannot retain the previous document's field path or picker.
  await page.getByRole('button', { name: 'Staging home', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-dataset]')?.getAttribute('data-current-dataset') === 'staging' && !document.querySelector('[data-editor-pane][data-loading]'));
  assert.equal(await page.locator('[data-media-library-pane]').count(), 0);
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' })).media, undefined);
  // Published candidate references use CMS type-level read checks and trusted producer query identity.
  for (let index = 0; index < 25; index++) unwrap(await content.api.docs.create({ dataset: 'prod', id: `author-${String(index).padStart(2, '0')}`, type: 'author', doc: { title: `Author ${index}` } }));
  await page.goto(`${base}/studio`); await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  await page.locator('[data-field-path="media.author"] [data-reference-open-picker]').click();
  await page.locator('[data-ref-picker-item]').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Choose reference', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Apply reference filter' }).count(), 1);
  assert.equal(await page.locator('[data-ref-picker]').evaluate(element => element.closest('label') === null), true);
  await page.locator('[data-ref-picker-close]').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('[data-ref-picker]').evaluate(element => element.contains(document.activeElement)), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-ref-picker-close]').evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-ref-picker]').count(), 0);
  assert.equal(await page.locator('[data-reference-open-picker]').evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: 'Choose reference', exact: true }).click();
  await page.locator('[data-ref-picker-item]').first().waitFor();
  assert.equal(await page.locator('[data-ref-picker-item]').count(), 20);
  assert.equal(await page.locator('[data-ref-picker-item]').first().getAttribute('data-ref-picker-item-id'), 'author-00');
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ref-picker-item]').length === 5);
  assert.equal(await page.locator('[data-ref-picker-item]').first().getAttribute('data-ref-picker-item-id'), 'author-20');
  await page.getByRole('textbox', { name: 'Filter references' }).fill('Author 23');
  await page.getByRole('button', { name: 'Apply reference filter', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ref-picker-item]').length === 1);
  await page.locator('input[data-field-path="media.caption"]').fill('Reference sibling survives');
  await page.locator('[data-ref-picker-item-id="author-23"] [data-ref-picker-select]').click();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  const withReference = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  assert.deepEqual(withReference.media.author, { _type: 'reference', _ref: 'author-23' });
  assert.equal(withReference.media.caption, 'Reference sibling survives'); assert.equal(withReference.media.attachment._ref, uploaded.assetId);
  await page.locator('[data-field-path="media.author"] [data-reference-open-picker]').click(); await page.locator('[data-ref-picker-item]').first().waitFor();
  allowReferences = false; const requestsBeforeDeny = requests.length;
  await page.getByRole('button', { name: 'Refresh references', exact: true }).click(); await page.locator('[data-ref-picker-denied]').waitFor();
  assert.equal(await page.locator('[data-ref-picker-item]').count(), 0); assert.deepEqual(requests.slice(requestsBeforeDeny), ['/cmsfn/references/query']);
  allowReferences = true;
  const requestReferences = async input => fetch(`${base}/cmsfn/references/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(response => response.json());
  const referencePage = unwrap(await requestReferences({ dataset: 'prod', types: ['author'] }));
  assert.equal((await requestReferences({ dataset: 'prod', types: ['author'], cursor: referencePage.nextCursor, search: 'Author 23' })).error.code, 'VALIDATION_FAILED');
  assert.equal((await requestReferences({ dataset: 'staging', types: ['author'] })).error.code, 'PERMISSION_DENIED');
  // Selection remains subject to ContentFn's authoritative reference validation at save time.
  await page.getByRole('button', { name: 'Refresh references', exact: true }).click(); await page.locator('[data-ref-picker-item]').first().waitFor();
  await page.locator('[data-ref-picker-item-id="author-00"] [data-ref-picker-select]').click();
  unwrap(await content.api.docs.delete({ dataset: 'prod', id: 'author-00' }));
  const beforeInvalidReference = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  const [rejectedSave] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.equal((await rejectedSave.json()).ok, false);
  assert.deepEqual(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' })), beforeInvalidReference);
  // Array widgets retain item ownership and persist real canonical producer values.
  unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ops: [{ op: 'set', path: 'items', value: [{ caption: 'Array first' }, { caption: 'Array second' }] }, { op: 'set', path: 'links', value: [] }, { op: 'set', path: 'files', value: [] }] }));
  await page.goto(`${base}/studio`); await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  const itemArray = page.locator('[data-widget="array"][data-field-path="items"]');
  const firstItem = itemArray.locator('[data-array-item]').first();
  const ownerId = await firstItem.getAttribute('data-array-item-id');
  await firstItem.locator('[data-asset-open-media]').click(); await page.locator('[data-media-item]').first().waitFor();
  await page.locator('input[data-field-path="items[0].caption"]').fill('Array first edited');
  await itemArray.getByRole('button', { name: 'Move item 1 down' }).click();
  assert.equal(await itemArray.locator('[data-array-item]').nth(1).getAttribute('data-array-item-id'), ownerId);
  await page.locator(`[data-media-item][data-asset-id="${uploaded.assetId}"] [data-media-select]`).click();
  await itemArray.locator('[data-array-item]').nth(1).getByRole('button', { name: 'Choose reference', exact: true }).click();
  await page.locator('[data-ref-picker-item]').first().waitFor();
  await page.getByRole('textbox', { name: 'Filter references' }).fill('Author 23');
  await page.getByRole('button', { name: 'Apply reference filter', exact: true }).click();
  await page.locator('[data-ref-picker-item-id="author-23"] [data-ref-picker-select]').click();
  // Removing an item with its library open cannot transfer that picker to its neighbor.
  await itemArray.locator('[data-array-item]').first().locator('[data-asset-open-media]').click();
  await page.locator('[data-media-item]').first().waitFor();
  await itemArray.getByRole('button', { name: 'Remove item 1' }).click();
  assert.equal(await page.locator('[data-media-library-pane]').count(), 0);
  const linkArray = page.locator('[data-widget="array"][data-field-path="links"]');
  await linkArray.getByRole('button', { name: 'Add item', exact: true }).click();
  await linkArray.getByRole('button', { name: 'Choose reference', exact: true }).click();
  await page.locator('[data-ref-picker-item-id="author-01"] [data-ref-picker-select]').click();
  const fileArray = page.locator('[data-widget="array"][data-field-path="files"]');
  await fileArray.getByRole('button', { name: 'Add item', exact: true }).click();
  await fileArray.locator('[data-asset-open-media]').click();
  await page.locator(`[data-media-item][data-asset-id="${uploaded.assetId}"] [data-media-select]`).click();
  const [arraySave] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.equal((await arraySave.json()).ok, true);
  const withArrays = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  assert.deepEqual(withArrays.items, [{ caption: 'Array first edited', 'literal.asset': { _type: 'asset', _ref: uploaded.assetId, assetType: 'file' }, author: { _type: 'reference', _ref: 'author-23' } }]);
  assert.deepEqual(withArrays.links, [{ _type: 'reference', _ref: 'author-01' }]);
  assert.deepEqual(withArrays.files, [{ _type: 'asset', _ref: uploaded.assetId, assetType: 'file' }]);
  // Richtext edits preserve portable keys, annotations, other blocks and embedded media.
  const richBlocks = [
    { _type: 'block', _key: 'first-block', style: 'h2', markDefs: [{ _key: 'link-a', _type: 'link', href: 'https://example.test/safe' }], children: [{ _type: 'span', _key: 'span-a', text: 'Linked text', marks: ['link-a'] }, { _type: 'span', _key: 'span-b', text: 'Second span', marks: ['strong'] }] },
    { _type: 'block', _key: 'second-block', children: [{ _type: 'span', _key: 'span-c', text: 'Other block', marks: [] }] },
  ];
  unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ops: [{ op: 'set', path: 'body', value: richBlocks }] }));
  await page.goto(`${base}/studio`); await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="drafts.editable"] [data-doc-open]').click();
  const richtext = page.locator('[data-widget="richtext"][data-field-path="body"]');
  await richtext.getByRole('textbox', { name: 'Span 1 text', exact: true }).first().fill('Edited linked text');
  await richtext.locator('[data-richtext-span]').first().getByRole('checkbox', { name: 'strong', exact: true }).check();
  await richtext.getByRole('button', { name: 'Insert media block', exact: true }).click();
  await page.locator(`[data-media-item][data-asset-id="${uploaded.assetId}"] [data-media-select]`).click();
  assert.equal(await richtext.getByRole('button', { name: 'Add text block', exact: true }).isDisabled(), true);
  const nestedRichtext = page.locator('[data-widget="richtext"][data-field-path="items[0].body"]');
  await nestedRichtext.getByRole('button', { name: 'Add text block', exact: true }).click();
  await nestedRichtext.getByRole('textbox', { name: 'Span 1 text', exact: true }).fill('Nested body');
  const [richSave] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/contentfn/docs/patch')), page.locator('[data-editor-save]').click()]);
  assert.equal((await richSave.json()).ok, true);
  const richDocument = unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  assert.deepEqual(richDocument.body[0], { ...richBlocks[0], children: [{ ...richBlocks[0].children[0], text: 'Edited linked text', marks: ['link-a', 'strong'] }, richBlocks[0].children[1]] });
  assert.deepEqual(richDocument.body[1], richBlocks[1]);
  assert.equal(richDocument.body[2]._type, 'asset'); assert.equal(richDocument.body[2]._ref, uploaded.assetId); assert.ok(richDocument.body[2]._key);
  assert.ok(richDocument.items[0].body[0]._key); assert.ok(richDocument.items[0].body[0].children[0]._key); assert.equal(richDocument.items[0].body[0].children[0].text, 'Nested body');
  const tooMany = [...richDocument.body, { _type: 'block', _key: 'extra', children: [] }];
  const rejectedRichtext = await fetch(`${base}/contentfn/docs/patch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset: 'prod', id: 'drafts.editable', ifRev: richDocument._rev, ops: [{ op: 'set', path: 'body', value: tooMany }] }) }).then(response => response.json());
  assert.equal(rejectedRichtext.error.code, 'VALIDATION_FAILED');
  assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }))._rev, richDocument._rev);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/cms-studio-browser.png', fullPage: true });
  console.log(JSON.stringify({ browser: await browser.version(), package: '@cmsfn/studio', route: '/studio', checks: ['canonical richtext blocks/spans/marks and media', 'nested richtext save and authoritative block cap', 'array item reorder/delete ownership and literal keys', 'canonical object/reference/asset arrays persisted', 'authorized reference pages and filters', 'nested canonical reference persistence', 'CMS type/dataset denial before producer', 'changed-filter cursor denial and deleted-target save rejection', 'media exact server byte limits and browser preflight', 'deterministic bounded media pages', 'nested canonical asset insertion and persisted sibling preservation', 'media permission revocation and document scope cleanup', 'trusted-audience preview target and exact scope verification', 'real cookie-authorized SSE refresh', 'token renewal and permission revocation', 'unsafe resolver denied before token request', 'no-config', 'boot', 'desk', 'actual ContentFn list', 'draft save with ifRev', 'concurrent conflict and refresh', 'draft-only discovery', 'published read-only view', 'source CAS fork and collision', 'workflow approval', 'publish and republish', 'role denial', 'unpublish preserves draft', 'dataset scope', 'singleton navigation and isolated saves', 'singleton denied/missing/type mismatch', 'unconfigured singleton makes no request', 'server-backed audit navigation/pagination', 'audit dataset isolation and denial', 'metadata-only webhook queue', 'release create/add/duplicate and partial publish', 'release dataset isolation and role denial', 'full revision history pages and snapshots', 'history permission revocation and dataset isolation', 'empty due schedule waits for membership before explicit host execution', 'committed publish lost ACK and stable-key recovery with one audit entry', 'complete export download and same-dataset restore', 'malformed import no mutation', 'default migration denial and explicit target-authorized migration', 'ops role denial and trusted producer identity', 'startup readiness and fail-closed capability/outage recovery'], requests: requests.length,
    remaining: ['remaining operational shell acceptance', 'native Safari and deployment acceptance'] }));
} finally {
  await browser?.close(); if (cms) { cms.closeAllConnections(); await new Promise(resolve => cms.close(resolve)); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); await cmsDb.close();
}
