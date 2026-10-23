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
const content = createContentfnServer({ db, authorize: (context, action, input) => !(denySingletonReads && context instanceof Request && action === 'docs.get' && String(input.id).replace(/^drafts\./, '') === 'private-home') });
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
await writeFile('studio-entry.mjs', `import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from '@cmsfn/studio'; createRoot(document.getElementById('root')).render(React.createElement(App));`);
await build({ entryPoints: ['studio-entry.mjs'], outfile: 'studio-bundle.js', bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
const bundle = await readFile('studio-bundle.js');
let base = ''; let cmsBase = ''; let cms; let allowPublish = true;
const requests = [];
const server = createServer((req, res) => {
  if (req.url?.startsWith('/cmsfn/')) { requests.push(req.url); cms.emit('request', req, res); return; }
  if (req.url?.startsWith('/contentfn/')) { requests.push(req.url); void content.handler(req, res); return; }
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
  cms = createCmsfnServer({ db: cmsDb, contentfn: { baseUrl: base }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'divider' }, getRolesForSubject: async () => allowPublish ? [{ id: 'editor', name: 'Editor', rules: [{ datasets: ['prod'], types: '*', actions: ['doc.publish', 'doc.unpublish'] }] }] : [] });
  await new Promise(resolve => cms.listen(0, '127.0.0.1', resolve));
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
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/cms-studio-browser.png', fullPage: true });
  console.log(JSON.stringify({ browser: await browser.version(), package: '@cmsfn/studio', route: '/studio', checks: ['no-config', 'boot', 'desk', 'actual ContentFn list', 'draft save with ifRev', 'concurrent conflict and refresh', 'draft-only discovery', 'published read-only view', 'source CAS fork and collision', 'workflow approval', 'publish and republish', 'role denial', 'unpublish preserves draft', 'dataset scope', 'singleton navigation and isolated saves', 'singleton denied/missing/type mismatch', 'unconfigured singleton makes no request'], requests: requests.length,
    remaining: ['full audit/release/operational shell integration', 'native Safari and deployment acceptance'] }));
} finally {
  await browser?.close(); if (cms) { cms.closeAllConnections(); await new Promise(resolve => cms.close(resolve)); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); await cmsDb.close();
}
