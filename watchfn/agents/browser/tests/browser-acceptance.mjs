// Build first. Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs if needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const bundle = await readFile(new URL('../dist/index.global.js', import.meta.url));
const received = [];
let transient = true;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
  if (req.url !== '/ingest') { res.setHeader('content-type', 'text/html'); res.end('<script src="/bundle.js"></script>'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  received.push({ auth: req.headers.authorization, events: JSON.parse(body) });
  const status = req.headers.authorization !== 'Bearer valid' ? 401 : transient ? 503 : 202;
  if (status === 503) transient = false;
  res.writeHead(status, { 'content-type': 'application/json' }); res.end('{}');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    let key = 'valid'; const errors = [];
    const client = new WatchFn.BrowserClient({ endpoint: '/ingest', projectId: 'browser', autoTrack: false,
      retries: 1, retryDelayMs: 1, apiKey: () => key, onError: error => errors.push(error.message) });
    client.track('retry', { nested: ['文', true] }); await client.flush();
    const firstPending = client.pendingCount;
    key = 'expired'; client.track('retained');
    let failed = false; try { await client.flush(); } catch { failed = true; }
    const retained = client.pendingCount;
    key = 'valid'; await client.close();
    let closed = false; try { client.track('after-close'); } catch { closed = true; }
    return { firstPending, failed, retained, finalPending: client.pendingCount, closed, errors };
  });
  assert.deepEqual({ ...result, errors: undefined }, { firstPending: 0, failed: true, retained: 1, finalPending: 0, closed: true, errors: undefined });
  assert.equal(result.errors.length, 1);
  assert.equal(received.length, 4);
  assert.deepEqual(received[0].events, received[1].events);
  assert.deepEqual(received[2].events, received[3].events);
  assert.equal(received[2].auth, 'Bearer expired'); assert.equal(received[3].auth, 'Bearer valid');
  assert.deepEqual(received[0].events[0].properties, { nested: ['文', true] });
  console.log(`Chrome ${browser.version()}: actual fetch 503 retry, 401 retention, refreshed auth, close and Unicode payload passed`);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
