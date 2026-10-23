// Execute in a normally installed consumer containing packed Studio and producer packages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createContentfnServer } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters';
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
const db = memoryAdapter();
const content = createContentfnServer({ db });
const schema = { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', required: true, type: { kind: 'primitive', type: 'string' } }] }] };
for (const dataset of ['prod', 'staging']) {
  unwrap(await content.api.datasets.create({ dataset }));
  unwrap(await content.api.schema.upsert({ dataset, schema }));
}
// Paired draft/published document exercises the current supported editor path.
for (const asDraft of [false, true]) unwrap(await content.api.docs.create({ dataset: 'prod', id: 'editable', type: 'post', doc: { title: 'Original title' }, asDraft }));
unwrap(await content.api.docs.create({ dataset: 'prod', id: 'published-only', type: 'post', doc: { title: 'Published only' } }));
unwrap(await content.api.docs.create({ dataset: 'prod', id: 'draft-only', type: 'post', doc: { title: 'Draft only' }, asDraft: true }));
unwrap(await content.api.docs.create({ dataset: 'staging', id: 'staging-post', type: 'post', doc: { title: 'Staging' } }));
await writeFile('studio-entry.mjs', `import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from '@cmsfn/studio'; createRoot(document.getElementById('root')).render(React.createElement(App));`);
await build({ entryPoints: ['studio-entry.mjs'], outfile: 'studio-bundle.js', bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
const bundle = await readFile('studio-bundle.js');
let base = '';
const requests = [];
const server = createServer((req, res) => {
  if (req.url?.startsWith('/contentfn/')) { requests.push(req.url); void content.handler(req, res); return; }
  if (req.url === '/studio-bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
  if (req.url?.startsWith('/studio')) {
    const config = { contentfn: { baseUrl: base }, datasets: [{ name: 'prod' }, { name: 'staging' }], auth: { kind: 'custom' }, desk: { kind: 'group', title: 'Content', children: [{ kind: 'documentList', title: 'Posts', dataset: 'prod', types: ['post'] }] } };
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><body><div id="root"></div>${req.url.includes('empty') ? '' : `<script>window.__CMSFN_CONFIG__=${JSON.stringify(config)}</script>`}<script type="module" src="/studio-bundle.js"></script></body></html>`); return;
  }
  res.writeHead(204); res.end();
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio?empty=1`);
  await page.locator('[data-studio-state="no-config"]').waitFor();
  await page.goto(`${base}/studio`);
  await page.locator('[data-studio-state="ready"]').waitFor();
  assert.equal(await page.locator('[data-current-dataset]').getAttribute('data-current-dataset'), 'prod');
  await page.getByRole('button', { name: 'Posts', exact: true }).click();
  await page.locator('[data-doc-id="editable"] [data-doc-open]').click();
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
  await page.locator('[data-doc-id="published-only"] [data-doc-open]').click();
  await page.locator('[data-editor-pane][data-error-code="DOCUMENT_NOT_FOUND"]').waitFor();
  await page.locator('[data-editor-back]').click();
  assert.equal(await page.locator('[data-doc-id="drafts.draft-only"]').count(), 0);
  await page.getByRole('combobox', { name: /select dataset/i }).selectOption('staging');
  await page.locator('[data-doc-id="staging-post"]').waitFor();
  assert.equal(await page.locator('[data-doc-id="editable"]').count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/cms-studio-browser.png', fullPage: true });
  console.log(JSON.stringify({ browser: await browser.version(), package: '@cmsfn/studio', route: '/studio', checks: ['no-config', 'boot', 'desk', 'actual ContentFn list', 'draft save with ifRev', 'concurrent conflict and refresh', 'dataset scope'], requests: requests.length,
    remaining: ['published-only editor requests nonexistent draft', 'draft-only documents absent from published CFQL list', 'App does not expose unpublish state'] }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close();
}
