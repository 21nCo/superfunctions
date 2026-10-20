// Build @watchfn/browser first. Uses a local server; no external delivery.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const bundle = await readFile(new URL('../dist/index.global.js', import.meta.url));
const received = [];
const held = [];
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
  if (req.url !== '/ingest') { res.setHeader('content-type', 'text/html'); res.end('<script src="/bundle.js"></script>'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const events = JSON.parse(body); received.push(events);
  if (events[0].id === 'hung') { held.push(res); return; }
  res.writeHead(events[0].id === 'retry' ? 503 : 202); res.end('{}');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => {
    window.client = new WatchFn.BrowserClient({ endpoint: '/ingest', projectId: 'app', autoTrack: false,
      retries: 2, retryDelayMs: 60000, timeoutMs: 60000 });
    window.old = client.capture({ id: 'hung' }).then(() => 'unexpected success', error => ({
      discarded: error instanceof WatchFn.BrowserDeliveryDiscardedError,
      delivery: error instanceof WatchFn.BrowserDeliveryError,
    }));
  });
  for (let i = 0; !held.length && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(held.length, 1);
  const result = await page.evaluate(async () => {
    const count = client.discardPending();
    const fresh = client.capture({ id: 'new' });
    const oldResult = await old; await fresh;
    return { count, oldResult, pending: client.pendingCount, discarded: client.discardedCount };
  });
  assert.deepEqual(result, { count: 1, oldResult: { discarded: true, delivery: true }, pending: 0, discarded: 1 });
  // A server may already have received an aborted request. Discard is not retraction.
  assert.deepEqual(received.map(batch => batch[0].id), ['hung', 'new']);
  held[0].end('{}');
  await page.evaluate(() => { window.retry = client.capture({ id: 'retry' }).catch(error => error instanceof WatchFn.BrowserDeliveryDiscardedError); });
  for (let i = 0; received.length < 3 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.length, 3);
  await new Promise(resolve => setTimeout(resolve, 30));
  const retryResult = await page.evaluate(async () => {
    const count = client.discardPending(); const rejected = await retry;
    await client.capture({ id: 'final' }); await client.close();
    return { count, rejected, pending: client.pendingCount, discarded: client.discardedCount };
  });
  assert.deepEqual(retryResult, { count: 1, rejected: true, pending: 0, discarded: 2 });
  assert.deepEqual(received.map(batch => batch[0].id), ['hung', 'new', 'retry', 'final']);
  console.log(`Chrome ${browser.version()}: actual HTTP hung request discard, immediate recapture, retry cancellation, cumulative count and close passed`);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
