import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { outputFiles } = await build({ stdin: {
  contents: `import {catchFn} from './src/index.ts';window.events=[];window.catcher=catchFn({name:'privacy',enableNetworkCapture:true,watch:{client:{capture:async event=>window.events.push(event)}}});`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)),
}, bundle: true, write: false, platform: 'browser', format: 'iife' });
const received = [];
const server = createServer((request, response) => {
  if (request.url === '/app.js') {
    response.setHeader('content-type', 'text/javascript'); response.end(outputFiles[0].text);
  } else if (request.url.startsWith('/api?')) {
    received.push(request.url); response.setHeader('content-type', 'application/json'); response.end('{}');
  } else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script src="/app.js"></script>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const report = await page.evaluate(async () => {
    await fetch('/api?token=fetch-private&safe=visible');
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', './api?TOKEN=xhr-private&safe=visible');
      // The collector records completion at loadend; finish that event dispatch
      // before taking the report snapshot (load fires earlier).
      xhr.onloadend = () => setTimeout(resolve, 0); xhr.onerror = reject; xhr.send();
    });
    await window.catcher.captureBug({ title: 'Relative URL privacy' });
    window.catcher.stop();
    return window.events[0];
  });
  assert.deepEqual(received, ['/api?token=fetch-private&safe=visible', '/api?TOKEN=xhr-private&safe=visible']);
  assert.equal(report.context.networkLogs.length, 2);
  assert.ok(report.context.networkLogs.every(entry => entry.url.includes('safe=visible') && entry.url.includes('REDACTED')));
  assert.ok(!JSON.stringify(report).includes('fetch-private') && !JSON.stringify(report).includes('xhr-private'));
  console.log(JSON.stringify({ browser: await browser.version(), actualRequests: received.length, fetchAndXHRUnchanged: true, finalReportSecretsAbsent: true, transport: 'injected acknowledgement' }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
