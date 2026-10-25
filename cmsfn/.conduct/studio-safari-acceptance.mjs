/** Native Safari over its owned WebDriver session. Never changes browser settings. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
export async function runNativeSafari({ base, content, requests, setDenyHistory }) {
  const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.result; };
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const driver = spawn('/usr/bin/safaridriver', ['-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', spawnError, session;
  for (const stream of [driver.stdout, driver.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192); });
  driver.on('error', error => { spawnError = error; });
  const exited = new Promise(resolve => { driver.once('exit', resolve); driver.once('error', resolve); });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const command = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(`Safari ${path}: ${JSON.stringify(result.value)}`);
    return result.value;
  };
  const call = (method, path, body) => command(method, `/session/${session}${path}`, body);
  const evaluate = (fn, ...args) => call('POST', '/execute/sync', { script: `return (${fn.toString()})(...arguments);`, args });
  const until = async (fn, label) => { const deadline = Date.now() + 15000; let last; do { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await pause(100); } while (Date.now() < deadline); throw new Error(`Timed out: ${label}${last ? ': '+last : ''}`); };
  const element = (selector, using = 'css selector') => until(async () => { const value = await call('POST', '/element', { using, value: selector }); return value['element-6066-11e4-a52e-4f735466cecf']; }, selector);
  const click = async selector => call('POST', `/element/${await element(selector)}/click`, {});
  const button = async text => call('POST', `/element/${await element(`//button[normalize-space(.)=${JSON.stringify(text)}]`, 'xpath')}/click`, {});
  const fill = async (selector, text) => { const id = await element(selector); await call('POST', `/element/${id}/clear`, {}); await call('POST', `/element/${id}/value`, { text }); };
  const wait = selector => until(() => evaluate(selector => !!document.querySelector(selector), selector), selector);
  const getDraft = async () => unwrap(await content.api.docs.get({ dataset: 'prod', id: 'editable', perspective: 'draft' }));
  const openEditor = async () => { await call('POST', '/url', { url: `${base}/studio` }); await button('Posts'); await click('[data-doc-id="drafts.editable"] [data-doc-open]'); await wait('input[data-field-path="title"]'); };
  try {
    await until(async () => { if (spawnError || driver.exitCode !== null) throw spawnError ?? Error(diagnostics); return command('GET', '/status'); }, 'driver ready');
    const created = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
    session = created.sessionId; assert.ok(session);
    await call('POST', '/timeouts', { script: 15000, pageLoad: 20000 });
    await call('POST', '/url', { url: `${base}/studio?empty=1` }); await wait('[data-studio-state="no-config"]');
    await openEditor();
    assert.equal(await evaluate(() => document.querySelector('[data-current-dataset]').getAttribute('data-current-dataset')), 'prod');
    await fill('input[data-field-path="title"]', 'Native Safari saved'); await click('[data-editor-save]');
    await until(async () => (await getDraft()).title === 'Native Safari saved', 'persisted native save');
    const beforeConflict = await getDraft();
    unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ifRev: beforeConflict._rev, ops: [{ op: 'set', path: 'title', value: 'Concurrent producer edit' }] }));
    await fill('input[data-field-path="title"]', 'Stale Safari edit'); await click('[data-editor-save]'); await wait('[data-conflict-banner]');
    assert.equal((await getDraft()).title, 'Concurrent producer edit'); await click('[data-conflict-refresh]');
    await until(() => evaluate(() => document.querySelector('input[data-field-path="title"]').value === 'Concurrent producer edit'), 'conflict refreshed');
    await button('History'); await wait('[data-history-revision]');
    assert.ok(await evaluate(() => document.querySelector('[data-history-content]').textContent.includes('Native Safari saved')));
    setDenyHistory(true); await button('Refresh history');
    await until(() => evaluate(() => document.body.textContent.includes('No access to document history.')), 'history denied');
    assert.equal(await evaluate(() => document.querySelectorAll('[data-history-revision]').length), 0); setDenyHistory(false);
    const asset = unwrap(await content.api.assets.upload({ dataset: 'prod', filename: 'native.txt', contentType: 'text/plain', bytesBase64: Buffer.from('native').toString('base64') }));
    unwrap(await content.api.docs.create({ dataset: 'prod', id: 'native-author', type: 'author', doc: { title: 'Native Author' } }));
    const richBlocks = [
      { _type: 'block', _key: 'native-block', style: 'h2', markDefs: [{ _key: 'native-link', _type: 'link', href: 'https://example.invalid' }], children: [{ _type: 'span', _key: 'native-span', text: 'Original linked text', marks: ['native-link'] }] },
      { _type: 'block', _key: 'preserved-block', children: [{ _type: 'span', _key: 'preserved-span', text: 'Preserved text', marks: [] }] },
    ];
    unwrap(await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ops: [{ op: 'set', path: 'body', value: richBlocks }, { op: 'set', path: 'items', value: [{ caption: 'First item' }, { caption: 'Second item' }] }] }));
    await openEditor();
    await click('[data-field-path="media.author"] [data-reference-open-picker]'); await wait('[data-ref-picker-item]');
    assert.equal(await evaluate(() => document.querySelector('[data-ref-picker]').closest('label')), null);
    await click('[data-ref-picker-item-id="native-author"] [data-ref-picker-select]');
    await click('[data-widget="array"][data-field-path="items"] [data-array-item] [data-asset-open-media]'); await wait('[data-media-item]');
    await fill('input[data-field-path="items[0].caption"]', 'First item edited'); await button('Move item 1 down');
    await click(`[data-asset-id="${asset.assetId}"] [data-media-select]`);
    const rich = '[data-widget="richtext"][data-field-path="body"]';
    await fill(`${rich} textarea`, 'Native linked edit');
    await call('POST', `/element/${await element('//section[@data-richtext-block][1]//label[normalize-space(.)="strong"]/input', 'xpath')}/click`, {});
    await call('POST', `/element/${await element('//div[@data-widget="richtext" and @data-field-path="body"]//button[normalize-space(.)="Insert media block"]', 'xpath')}/click`, {});
    await click(`[data-asset-id="${asset.assetId}"] [data-media-select]`);
    await click('[data-editor-save]'); await until(async () => (await getDraft()).body[0].children[0].text === 'Native linked edit', 'canonical richtext persisted');
    const saved = await getDraft();
    assert.deepEqual(saved.body[0], { ...richBlocks[0], children: [{ ...richBlocks[0].children[0], text: 'Native linked edit', marks: ['native-link', 'strong'] }] });
    assert.deepEqual(saved.body[1], richBlocks[1]); assert.equal(saved.body[2]._ref, asset.assetId);
    assert.deepEqual(saved.media.author, { _type: 'reference', _ref: 'native-author' });
    assert.deepEqual(saved.items, [{ caption: 'Second item' }, { caption: 'First item edited', 'literal.asset': { _type: 'asset', _ref: asset.assetId, assetType: 'file' } }]);
    const tooMany = await content.api.docs.patch({ dataset: 'prod', id: 'drafts.editable', ifRev: saved._rev, ops: [{ op: 'set', path: 'body', value: [...saved.body, { _type: 'block', _key: 'overflow', children: [] }] }] });
    assert.equal(tooMany.error.code, 'VALIDATION_FAILED'); assert.equal((await getDraft())._rev, saved._rev);
    await click('[data-workflow-state="approved"]'); await wait('[data-workflow-controls][data-current-state="approved"]'); await click('[data-publish-button]');
    await until(async () => { const result = await content.api.docs.get({ dataset: 'prod', id: 'editable' }); return result.ok && result.result.body?.[0]?.children?.[0]?.text === 'Native linked edit'; }, 'published canonical native edits');
    await button('Staging home'); await wait('input[data-field-path="title"]');
    await until(() => evaluate(() => document.querySelector('input[data-field-path="title"]').value === 'staging home'), 'dataset singleton');
    await fill('input[data-field-path="title"]', 'Native staging only'); await click('[data-editor-save]');
    await until(async () => unwrap(await content.api.docs.get({ dataset: 'staging', id: 'home', perspective: 'draft' })).title === 'Native staging only', 'staging persistence');
    assert.equal(unwrap(await content.api.docs.get({ dataset: 'prod', id: 'home', perspective: 'draft' })).title, 'prod home');
    const screenshot = await call('GET', '/screenshot'); await writeFile('/tmp/cms-native-safari.png', Buffer.from(screenshot, 'base64'));
    console.log(JSON.stringify({ nativeSafari: created.capabilities, requests: requests.length, checks: ['full installed App/no-config/boot', 'native draft save and revision conflict', 'history snapshots and revoked permission', 'canonical references', 'array reorder with pending media selection and sibling preservation', 'canonical richtext marks/annotations/media and producer limit', 'workflow approval/publish', 'cross-dataset singleton isolation'], remaining: ['native matrix does not yet include all Chromium operational, preview and pagination cases', 'deployed authentication/CORS/external storage'] }));
  } catch (error) {
    if (session) await evaluate(() => ({ text: document.body.textContent, html: document.querySelector('[data-editor-pane]')?.outerHTML })).then(value => console.error('Owned Safari failure state:', JSON.stringify(value))).catch(() => {});
    throw error;
  } finally {
    try { if (session) await command('DELETE', `/session/${session}`); } finally {
      driver.kill('SIGTERM'); await exited; console.log('Owned Safari WebDriver process closed');
    }
  }
}
