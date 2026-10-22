import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const profile = await mkdtemp(join(tmpdir(), 'logfn-browser-'));
let online = false;
const received = [];
const server = createServer(async (req, res) => {
  if (req.url === '/ingest') {
    let body = ''; for await (const chunk of req) body += chunk;
    if (!online) { res.writeHead(503).end(); return; }
    received.push(JSON.parse(body)); res.writeHead(202).end(); return;
  }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>LogFn offline acceptance</title>'); return; }
  const relative = req.url.slice(1);
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root, 'logfn/typescript/dist') + '/')) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let context;
const launch = () => chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  context = await launch(); let page = await context.newPage(); await page.goto(url);
  const failed = await page.evaluate(async () => {
    const { sinkHttp, createLogger } = await import('/logfn/typescript/dist/index.js');
    const sink = sinkHttp({ url: '/ingest', offlineBuffer: 'indexeddb', retry: { attempts: 1 }, flushIntervalMs: 60000 });
    const logger = createLogger({ name: 'browser', sinks: [sink], correlation: { userId: 'browser-private-user' }, pipeline: [event => ({ ...event, extra: { apiKey: 'pipeline-private' } })] });
    logger.child({}).info('survives process restart', { password: 'browser-private-password', nested: { token: 'browser-private-token' } });
    try { await logger.flush(); return false; } catch { return true; }
  });
  assert.equal(failed, true); assert.equal(received.length, 0);
  const durablePayloads = await page.evaluate(async () => {
    const databases = await indexedDB.databases(); const rows = [];
    for (const info of databases) { const database = await new Promise((resolve, reject) => { const request = indexedDB.open(info.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { for (const name of database.objectStoreNames) rows.push(...await new Promise((resolve, reject) => { const request = database.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })); } finally { database.close(); }
    }
    return JSON.stringify(rows);
  });
  for (const secret of ['browser-private-user', 'browser-private-password', 'browser-private-token', 'pipeline-private']) assert.ok(!durablePayloads.includes(secret));
  assert.ok(durablePayloads.includes('[redacted]'));
  await context.close(); context = undefined;
  online = true;
  context = await launch(); page = await context.newPage(); await page.goto(url);
  await page.evaluate(async () => {
    const { sinkHttp } = await import('/logfn/typescript/dist/index.js');
    const sink = sinkHttp({ url: '/ingest', offlineBuffer: 'indexeddb', retry: { attempts: 1 } });
    await sink.close();
  });
  assert.equal(received.length, 1); assert.equal(received[0].events[0].msg, 'survives process restart');
  assert.equal(received[0].events[0].ctx.password, '[redacted]'); assert.equal(received[0].events[0].userId, '[redacted]'); assert.equal(received[0].events[0].extra.apiKey, '[redacted]');
  await page.reload();
  await page.evaluate(async () => {
    const { sinkHttp } = await import('/logfn/typescript/dist/index.js');
    await sinkHttp({ url: '/ingest', offlineBuffer: 'indexeddb' }).close();
  });
  assert.equal(received.length, 1);
  console.log(JSON.stringify({ ok: true, browser: await context.browser()?.version(), defaultPrivacyBeforeIndexedDB: true, failedDeliveryPersisted: true, processRestartRecovered: true, acknowledgedRecordsRemoved: true }));
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
