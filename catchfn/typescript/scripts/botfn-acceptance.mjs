// Build CatchFn, WatchFn/browser and WatchFn/core first; local SQLite and Chrome required.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const requests = []; const issues = []; const catchers = [];
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
      infra: { enabled: false }, auth: { apiKey: 'full-watch-fixture-key' }, botfn: { namespace: 'shop-test', routes: [{ app: 'shop', target: 'github', project: 'acme/bugs', client: github }] } });
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
      if (req.method === 'GET') {
        res.setHeader('content-type', req.url === '/app.js' ? 'application/javascript' : 'text/html');
        res.end(req.url === '/app.js' ? await readFile(bundle) : '<!doctype html><html><body><script src="/app.js"></script></body></html>'); return;
      }
      const body = await bytes(req); if (req.url === '/watch/ingest') requests.push(JSON.parse(body));
      if (req.url === '/watch/issues/status') {
        statusReads++;
        if (statusMode === 'unavailable') { json(res, { error: 'unavailable' }, 503); return; }
        if (statusMode === 'hang') return;
        if (statusMode === 'unsafe') { const ref = JSON.parse(body); json(res, { ...ref, target: 'github', state: 'linked', issueId: '7', issueUrl: 'javascript:alert(1)' }); return; }
      }
      const response = await watch.httpRouter.handle(new Request('http://local' + req.url.replace(/^\/watch/, ''), { method: req.method, headers: req.headers, body }));
      if (req.url === '/watch/ingest' && response.ok && dropAfterStorage) { dropAfterStorage = false; res.destroy(); return; }
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
  await build({ stdin: { contents: `import {catchFn} from './catchfn/typescript/src/index.ts'; window.catcher=catchFn({name:'shop',reporter:{screenshot:false,floatingButton:true},issueStatus:{enabled:true,intervalMs:100,maxAttempts:30,timeoutMs:5000},integration:{target:'github',project:'acme/bugs'},watch:{endpoint:${JSON.stringify(endpoint)},apiKey:'full-watch-fixture-key',retries:0}});`, resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', outfile: bundle });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); await page.goto(origin);
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
  await openReporter('Widget delayed issue'); await waitForStatusRead(0);
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
  assert.equal((await watch.getBugIssueStatus({ app: 'shop', reportId: browserReport.id })).issueUrl, 'https://github.com/acme/bugs/issues/2');
  await watch.processBugIssues(); assert.equal(issues.length, 6);
  console.log('CatchFn built SDK and Chrome -> WatchFn HTTP -> SQLite reopen -> actual BotFn GitHub HTTP contract passed; lost intake replay deduplicated, auth/route denial, pending acknowledgment, verified durable linkage and mounted widget status polling/cancellation');
} finally {
  globalThis.fetch = originalFetch;
  for (const catcher of catchers) catcher.stop();
  if (browser) await browser.close();
  await closeServer(api); await closeServer(provider);
  if (watch) { await watch.flush().catch(() => {}); await watch.stop().catch(() => {}); }
  if (sql) await sql.destroy();
  await rm(temporary, { recursive: true, force: true });
}
