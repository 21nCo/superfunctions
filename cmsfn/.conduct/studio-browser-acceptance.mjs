// Execute in a normally installed consumer containing packed Studio and producer packages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createContentfnServer } from '@contentfn/server';
import { createCmsfnServer } from '@cmsfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters';
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
const db = memoryAdapter();
const cmsDb = memoryAdapter();
let denySingletonReads = false;
const content = createContentfnServer({ db, context: request => Object.assign(request, { subject: request.headers.get('authorization') === 'Bearer fixture-release-service' ? 'scheduler' : undefined }), webhookAuditWriterSchemaVersion: 4, authorize: (context, action, input) => context instanceof Request && ['datasets.export', 'datasets.import'].includes(action) ? context.headers.get('authorization') === 'Bearer fixture-ops-service' : !(denySingletonReads && context instanceof Request && action === 'docs.get' && String(input.id).replace(/^drafts\./, '') === 'private-home') });
const schema = { version: 1, documentTypes: ['post', 'page'].map(name => ({ name, fields: [{ name: 'title', required: true, type: { kind: 'primitive', type: 'string' } }] })) };
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
  if (req.url === '/studio-bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
  if (req.url?.startsWith('/studio')) {
    const config = { contentfn: { baseUrl: base }, cmsfn: { apiUrl: cmsBase }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'group', title: 'Content', children: [{ kind: 'documentList', title: 'Posts', dataset: 'prod', types: ['post'] },
      { kind: 'singleton', title: 'Production home', dataset: 'prod', type: 'page', id: 'home' },
      { kind: 'singleton', title: 'Staging home', dataset: 'staging', type: 'page', id: 'home' },
      { kind: 'singleton', title: 'Private home', dataset: 'prod', type: 'page', id: 'private-home' },
      { kind: 'singleton', title: 'Missing home', dataset: 'prod', type: 'page', id: 'missing-home' },
      { kind: 'singleton', title: 'Wrong type home', dataset: 'prod', type: 'page', id: 'editable' },
      { kind: 'singleton', title: 'Unconfigured home', dataset: 'unconfigured', type: 'page', id: 'home' },
    ] } };
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><body><div id="root"></div>${req.url.includes('empty') ? '' : `<script>window.__CMSFN_CONFIG__=${JSON.stringify(config)}</script>`}<script type="module" src="/studio-bundle.js"></script></body></html>`); return;
  }
  res.writeHead(204); res.end();
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  cms = createCmsfnServer({ db: cmsDb, releaseExecutionSchemaVersion: 2, resolveReleaseExecutionIdentity: async () => ({ subject: 'scheduler', headers: { authorization: 'Bearer fixture-release-service' }, roles: [{ id: 'service', name: 'Service', rules: [{ datasets: ['prod', 'staging'], types: '*', actions: ['release.manage', 'doc.publish'] }] }] }), contentfnOpsHeaders: () => ({ authorization: 'Bearer fixture-ops-service' }), authorizeCrossDatasetImport: async (_req, input) => allowMigration && input.sourceDataset === 'prod' && input.targetDataset === 'staging', contentfn: { baseUrl: base }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'divider' }, getRolesForSubject: async () => [{ id: 'editor', name: 'Editor', rules: [...(allowPublish ? [{ datasets: ['prod'], types: '*', actions: ['doc.publish', 'doc.unpublish'] }] : []), ...(allowAudit ? [{ datasets: ['prod', 'staging'], types: '*', actions: ['audit.read'] }] : []), ...(allowReleases ? [{ datasets: ['prod', 'staging'], types: '*', actions: ['release.manage'] }] : [])] }] });
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
  await page.waitForFunction(() => document.querySelector('input[data-field-path="title"]')?.value === 'Concurrent edit');
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
  await page.getByRole('button', { name: 'Staging home', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[data-field-path="title"]')?.value === 'staging home');
  assert.equal(await page.getByRole('combobox', { name: 'Select dataset' }).inputValue(), 'staging');
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
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/cms-studio-browser.png', fullPage: true });
  console.log(JSON.stringify({ browser: await browser.version(), package: '@cmsfn/studio', route: '/studio', checks: ['no-config', 'boot', 'desk', 'actual ContentFn list', 'draft save with ifRev', 'concurrent conflict and refresh', 'draft-only discovery', 'published read-only view', 'source CAS fork and collision', 'workflow approval', 'publish and republish', 'role denial', 'unpublish preserves draft', 'dataset scope', 'singleton navigation and isolated saves', 'singleton denied/missing/type mismatch', 'unconfigured singleton makes no request', 'server-backed audit navigation/pagination', 'audit dataset isolation and denial', 'metadata-only webhook queue', 'release create/add/duplicate and partial publish', 'release dataset isolation and role denial', 'empty due schedule waits for membership before explicit host execution', 'committed publish lost ACK and stable-key recovery with one audit entry', 'complete export download and same-dataset restore', 'malformed import no mutation', 'default migration denial and explicit target-authorized migration', 'ops role denial and trusted producer identity', 'startup readiness and fail-closed capability/outage recovery'], requests: requests.length,
    remaining: ['history and remaining operational shell acceptance', 'native Safari and deployment acceptance'] }));
} finally {
  await browser?.close(); if (cms) { cms.closeAllConnections(); await new Promise(resolve => cms.close(resolve)); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); await cmsDb.close();
}
