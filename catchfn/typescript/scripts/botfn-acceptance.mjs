// Build CatchFn, WatchFn/browser and WatchFn/core first; local SQLite and Chrome required.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { catchFn } from '../dist/index.js';
const watchModule = process.env.CATCHFN_WATCH_CORE ? pathToFileURL(process.env.CATCHFN_WATCH_CORE).href : new URL('../../../watchfn/typescript/dist/index.mjs', import.meta.url).href;
const { WatchFn, getWatchFnSchema, getBugIssueSchema } = await import(watchModule);
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve(new URL('../../..', import.meta.url).pathname);
const temporary = await mkdtemp(join(tmpdir(), 'catchfn-botfn-'));
const originalFetch = globalThis.fetch;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const requests = []; const issues = []; const catchers = []; const uploads = [];
let sql, watch, api, provider, browser, endpoint, bundle;
let dropAfterStorage = true;
let statusMode = "normal"; let statusReads = 0;
const closeServer = async server => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const bytes = async request => { const parts = []; for await (const part of request) parts.push(part); return Buffer.concat(parts); };
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
try {
  const providerBundle = join(temporary, 'github.mjs');
  await build({ entryPoints: [join(root, 'botfn/github-integration/src/api.ts')], bundle: true, platform: 'node', format: 'esm', outfile: providerBundle });
  const { GitHubClient } = await import(pathToFileURL(providerBundle));
  provider = createServer(async (req, res) => {
    try {
      if (req.url === '/app/installations/456/access_tokens') {
        const jwt = req.headers.authorization.slice(7); const [header, payload, signature] = jwt.split('.');
        assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '123');
        json(res, { token: 'installation-fixture-secret' }); return;
      }
      assert.equal(req.url, '/repos/acme/bugs/issues'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'token installation-fixture-secret');
      const input = JSON.parse(await bytes(req)); assert.match(input.body, /<!-- watchfn-bug:[a-f0-9]{64} -->/);
      assert.equal(input.body.includes('retained-context'), false);
      issues.push(input);
      json(res, { number: issues.length, html_url: `https://github.com/acme/bugs/issues/${issues.length}`, body: input.body }, 201);
    } catch (error) { json(res, { error: error.message }, 500); }
  });
  const providerOrigin = await listen(provider);
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === 'https://api.github.com') return originalFetch(providerOrigin + url.pathname, init);
    if (endpoint && url.origin === new URL(endpoint).origin) return originalFetch(input, init);
    throw new Error('Unexpected external request');
  };
  const github = new GitHubClient({ appId: '123', installationId: '456', privateKey: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() });
  const connect = () => {
    sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(join(temporary, 'bugs.sqlite')) }) });
    watch = new WatchFn({ name: 'shop', storage: 'database', database: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events', watchfn_bug_issues: 'watchfn_bug_issues' } }),
      infra: { enabled: false }, auth: { provider: { authenticate: async request => { const token = request.headers.get('authorization'); const scopes = token === 'Bearer full-watch-fixture-key' ? ['watchfn:ingest','watchfn:query','watchfn:issues:status'] : token === 'Bearer browser-only-key' ? ['watchfn:ingest','watchfn:issues:status'] : null; return scopes ? {id:'fixture',type:'api-key',subject:{actorId:'fixture',actorType:'api-key'},scopes} : null; } } }, retention: { apps: ['shop'], bugReportTtlMs: 1 }, botfn: { namespace: 'shop-test', routes: [{ app: 'shop', target: 'github', project: 'acme/bugs', client: github }] } });
    watch.start();
  };
  connect();
  for (const [name, table] of Object.entries({ ...getWatchFnSchema(), ...getBugIssueSchema() })) {
    let migration = sql.schema.createTable(name);
    for (const [field, options] of Object.entries(table.fields)) migration = migration.addColumn(field, options.type === 'number' ? (field === 'eventTimestamp' ? 'real' : 'integer') : 'text', column => field === 'id' ? column.primaryKey() : options.required ? column.notNull() : column);
    await migration.execute();
    for (const index of table.indexes ?? []) await sql.schema.createIndex(index.name).on(name).columns(index.fields).execute();
  }
  api = createServer(async (req, res) => {
    try {
      if (req.url === '/upload' && req.method === 'POST') {
        assert.equal(req.headers.authorization, 'Bearer upload-only');
        const content = await bytes(req); assert.ok(content.length > 1 && content.length < 2000000);
        const path = join(temporary, `screenshot-${uploads.length}.png`);
        await writeFile(path, content, { mode: 0o600 }); uploads.push({ path, content });
        json(res, { url: new URL(endpoint).origin + '/files/' + (uploads.length - 1) }); return;
      }
      if (req.method === 'GET' && req.url.startsWith('/files/')) {
        const item = uploads[Number(req.url.slice('/files/'.length))];
        if (!item) { res.writeHead(404); res.end(); return; }
        res.setHeader('content-type', 'image/png'); res.end(await readFile(item.path)); return;
      }
      if (req.method === 'GET') {
        res.setHeader('content-type', req.url === '/app.js' ? 'application/javascript' : 'text/html');
        res.end(req.url === '/app.js' ? await readFile(bundle) : '<!doctype html><html><body><div data-catchfn-mask style="position:fixed;left:10px;top:10px;width:100px;height:40px;background:white;color:red">PRIVATE VALUE</div><script src="/app.js"></script></body></html>'); return;
      }
      const body = await bytes(req); if (req.url === '/watch/ingest') requests.push(JSON.parse(body));
      if (req.url === '/watch/issues/status') {
        statusReads++;
        if (statusMode === 'unavailable') { json(res, { error: 'unavailable' }, 503); return; }
        if (statusMode === 'hang') return;
        if (statusMode === 'unsafe') { const ref = JSON.parse(body); json(res, { ...ref, target: 'github', state: 'linked', issueId: '7', issueUrl: 'javascript:alert(1)' }); return; }
      }
      const response = await watch.httpRouter.handle(new Request('http://local' + req.url.replace(/^\/watch/, ''), { method: req.method, headers: req.headers, body }));
      if (req.url === '/watch/ingest' && response.ok && dropAfterStorage) { const unavailable = dropAfterStorage === 'unavailable'; dropAfterStorage = false; if(unavailable) json(res,{error:'Acknowledgement unavailable'},503); else res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  const origin = await listen(api); endpoint = origin + '/watch/ingest';
  const query = async options => {
    const response = await originalFetch(origin + '/watch/query', { method: 'POST', headers: { authorization: 'Bearer full-watch-fixture-key', 'content-type': 'application/json' }, body: JSON.stringify(options) });
    assert.equal(response.status, 200); return (await response.json()).results;
  };
  const client = (extra = {}) => {
    const catcher = catchFn({ name: 'shop', sessionId: 'session', integration: { target: 'github', project: 'acme/bugs' }, watch: { endpoint, apiKey: 'full-watch-fixture-key', retries: 1, retryDelayMs: 0, timeoutMs: 1000, ...extra } });
    catchers.push(catcher); return catcher;
  };
  const catcher = client();
  const report = await catcher.captureBug({ title: 'Lost intake acknowledgment', metadata: { password: 'redacted-value', note: 'retained-context' } });
  assert.equal(report.delivery, 'sent'); assert.deepEqual(report.integration, { target: 'github', project: 'acme/bugs' });
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0][0].context.custom.password, '[REDACTED]');
  assert.equal((await query({ where: { id: report.id } })).length, 1); assert.equal(issues.length, 0);
  const denied = client({ apiKey: 'wrong' }); await assert.rejects(denied.captureBug({ title: 'Unauthorized' }), error => error.status === 401);
  const forged = client(); await assert.rejects(forged.captureBug({ title: 'Forged destination', integration: { target: 'github', project: 'attacker/repo' } }), error => error.status === 400);
  await watch.stop(); await sql.destroy(); sql = undefined; connect();
  assert.equal((await watch.getBugIssueStatus({ app: 'shop', reportId: report.id })).state, 'pending');
  await watch.processBugIssues(); assert.equal(issues.length, 1);
  const linked = (await query({ where: { id: report.id } }))[0];
  assert.equal(linked.integration.issueUrl, 'https://github.com/acme/bugs/issues/1');
  assert.deepEqual(linked.context, requests[0][0].context);
  // Submit through a real browser and built browser-compatible CatchFn source.
  bundle = join(temporary, 'browser.js');
  await build({ stdin: { contents: `import {catchFn} from './catchfn/typescript/dist/index.js'; window.catcher=catchFn({name:'shop',reporter:{screenshot:true,floatingButton:true,maxInlineBytes:1},uploadAttachment:async blob=>{const response=await fetch('/upload',{method:'POST',headers:{authorization:'Bearer upload-only'},body:blob});if(!response.ok)throw new Error('Upload failed');return response.json();},issueStatus:{enabled:true,intervalMs:100,maxAttempts:30,timeoutMs:5000},integration:{target:'github',project:'acme/bugs'},watch:{endpoint:${JSON.stringify(endpoint)},apiKey:'browser-only-key',retries:0}});`, resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', outfile: bundle });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({viewport:{width:800,height:600}}); await page.goto(origin);
  assert.equal(await page.evaluate(async()=> (await fetch('/watch/query',{method:'POST',headers:{authorization:'Bearer browser-only-key','content-type':'application/json'},body:'{}'})).status),403);
  const browserReport = await page.evaluate(() => window.catcher.captureBug({ title: 'Browser issue', severity: 'high' }));
  assert.equal(browserReport.delivery, 'sent'); assert.equal(browserReport.integration.issueId, undefined);
  await watch.processBugIssues(); assert.equal(issues.length, 2);
  assert.equal((await watch.getBugIssueStatus({ app: 'shop', reportId: browserReport.id })).state, 'linked');
  assert.equal(statusReads, 0); // Standalone capture never starts status polling.
  const openReporter = async title => {
    await page.evaluate(() => window.catcher.closeReporter());
    await page.getByRole('button', { name: 'Report a bug', exact: true }).click();
    await page.locator('input[name=title]').fill(title);
    await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  };
  const waitForStatusRead = async previous => {
    for (let count = 0; count < 100 && statusReads <= previous; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(statusReads > previous, 'browser must read the default mounted status route');
  };
  await page.getByRole('button', { name: 'Report a bug', exact: true }).click();
  await page.locator('input[name=title]').fill('Widget delayed issue');
  const canvas = page.getByLabel('Screenshot annotation canvas');
  await canvas.waitFor();
  await page.getByRole('button', {name:'Box',exact:true}).click();
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x+120,bounds.y+80); await page.mouse.down();
  await page.mouse.move(bounds.x+180,bounds.y+120,{steps:4}); await page.mouse.up();
  dropAfterStorage = 'unavailable';
  const requestCount = requests.length;
  await page.getByRole('button', {name:'Submit report',exact:true}).click();
  await page.getByRole('button', {name:'Retry same report',exact:true}).waitFor({timeout:10000}).catch(async error=>{console.error({status:await page.getByRole('status').allTextContents(),uploads:uploads.length,requests:requests.length});throw error;});
  assert.equal(uploads.length,1);
  await page.getByRole('button', {name:'Retry same report',exact:true}).click();
  await waitForStatusRead(0);
  assert.equal(uploads.length,1,'lost intake acknowledgement must not reupload screenshot');
  assert.equal(requests.length,requestCount+2);
  assert.deepEqual(requests[requestCount],requests[requestCount+1]);
  const screenshotReport = requests[requestCount][0];
  const screenshot = screenshotReport.attachments[0];
  assert.equal(screenshot.dataUrl,undefined);
  assert.ok(screenshot.annotationScene.elements.some(element=>element.type==='rectangle'));
  assert.ok(screenshot.annotationScene.elements.every(element=>element.type!=='image'));
  const pixels = await page.evaluate(async ({url,rectangle})=>{
    const image=new Image(); image.src=url; await image.decode();
    const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
    const context=canvas.getContext('2d'); context.drawImage(image,0,0);
    return {masked:[...context.getImageData(16,16,1,1).data],border:[...context.getImageData(Math.round(rectangle.x+rectangle.w/2),Math.round(rectangle.y),1,1).data]};
  },{url:screenshot.url,rectangle:screenshot.annotationScene.elements.find(element=>element.type==='rectangle')});
  assert.ok(pixels.border.slice(0,3).some(channel=>channel<200),'annotation must be painted into uploaded pixels');
  assert.ok(pixels.masked.slice(0,3).every(channel=>channel<40),'uploaded screenshot must mask private element');
  assert.deepEqual(Buffer.from(await(await originalFetch(screenshot.url)).arrayBuffer()),uploads[0].content);
  assert.deepEqual((await query({where:{id:screenshotReport.id}}))[0].attachments,screenshotReport.attachments);
  assert.equal(await page.getByRole('link', { name: 'View issue' }).count(), 0);
  await watch.processBugIssues();
  const issueLink = page.getByRole('link', { name: 'View issue' }); await issueLink.waitFor();
  assert.equal(await issueLink.getAttribute('href'), 'https://github.com/acme/bugs/issues/3');
  assert.equal(await issueLink.getAttribute('rel'), 'noopener noreferrer');
  statusMode = 'unavailable'; await openReporter('Status service unavailable');
  await page.getByRole('status').filter({ hasText: 'Report submitted. Issue status is currently unavailable.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry same report', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Submit report', exact: true }).isDisabled(), true);
  statusMode = 'unsafe'; await openReporter('Unsafe receipt');
  await page.getByRole('status').filter({ hasText: 'Report submitted. Issue status is currently unavailable.' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'View issue' }).count(), 0);
  statusMode = 'hang'; const previousReads = statusReads; await openReporter('Close cancels status'); await waitForStatusRead(previousReads);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const closedReads = statusReads; await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(statusReads, closedReads);
  assert.equal(await page.getByRole('dialog').count(), 0);
  // The accepted reports survive status failures/cancellation; they were never resubmitted.
  statusMode = 'normal'; assert.equal((await query({ metric: 'bug_report' })).length, 6);
  await watch.processBugIssues(); assert.equal(issues.length, 6);
  await page.evaluate(() => window.catcher.stop()); await browser.close(); browser = undefined;
  await watch.stop(); await sql.destroy(); sql = undefined; connect();
  assert.equal((await query({ metric: 'bug_report' })).length, 6);
  assert.deepEqual((await query({where:{id:screenshotReport.id}}))[0].attachments,screenshotReport.attachments);
  assert.deepEqual(await readFile(uploads[0].path),uploads[0].content);
  assert.equal((await watch.getBugIssueStatus({ app: 'shop', reportId: browserReport.id })).issueUrl, 'https://github.com/acme/bugs/issues/2');
  await watch.processBugIssues(); assert.equal(issues.length, 6);
  // Cleanup is explicitly host-scheduled. Expiration preserves durable receipt
  // identity and the SDK's status path without recreating provider side effects.
  let after; let deleted = 0;
  do { const page = await watch.cleanupRetention({ after, limit: 2 }); deleted += page.deleted; after = page.nextCursor ?? undefined; } while (after !== undefined);
  assert.equal(deleted, 6); assert.deepEqual(await query({ metric: 'bug_report' }), []);
  assert.equal((await watch.cleanupRetention()).deleted, 0);
  const replay = await originalFetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer full-watch-fixture-key', 'content-type': 'application/json' }, body: JSON.stringify({ events: requests[0] }) });
  assert.equal(replay.status, 202); await watch.processBugIssues(); assert.equal(issues.length, 6);
  assert.deepEqual(await query({ metric: 'bug_report' }), []);
  await watch.stop(); await sql.destroy(); sql = undefined; connect();
  const statusCatcher = catchFn({ name: 'shop', issueStatus: { enabled: true, timeoutMs: 1000 }, watch: { endpoint, apiKey: 'full-watch-fixture-key', timeoutMs: 1000 } });
  catchers.push(statusCatcher);
  const retainedStatus = await statusCatcher.pollIssueStatus(report.id);
  assert.equal(retainedStatus.state, 'linked'); assert.equal(retainedStatus.issueUrl, 'https://github.com/acme/bugs/issues/1');
  assert.deepEqual(await query({ metric: 'bug_report' }), []);
  assert.equal((await sql.selectFrom('watchfn_bug_issues').selectAll().execute()).length, 6);
  console.log('CatchFn built SDK and Chrome -> WatchFn HTTP -> SQLite reopen -> actual BotFn GitHub HTTP contract passed; lost intake replay deduplicated, auth/route denial, masked annotated screenshot upload with same-report retry, verified widget links, bounded payload expiration and durable replay/status receipts');
} finally {
  globalThis.fetch = originalFetch;
  for (const catcher of catchers) catcher.stop();
  if (browser) await browser.close();
  await closeServer(api); await closeServer(provider);
  if (watch) { await watch.flush().catch(() => {}); await watch.stop().catch(() => {}); }
  if (sql) await sql.destroy();
  await rm(temporary, { recursive: true, force: true });
}
