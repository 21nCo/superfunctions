// Native browser persistence acceptance. Use an installed Playwright module and a disposable Chromium context.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ entryPoints: [resolve(packageRoot, 'src/core/cache-manager.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*', '@superfunctions/db', '@superfunctions/storage-local'] });
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/cache.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/cache.js' ? bundle.outputFiles[0].text : '<!doctype html><title>BrowseFn cache acceptance</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
try {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const first = await page.evaluate(async () => {
    const { CacheManager } = await import('/cache.js');
    const config = { enabled: true, storage: 'indexeddb', name: 'native-cache', ttl: 60000 };
    const a = new CacheManager(config), b = new CacheManager(config);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).set('web', `url${i}`, { value: i, bytes: new Uint8Array([i, 255]) })));
    const other = new CacheManager({ ...config, name: 'native-cache:child' }); await other.set('web', 'other', 'isolated');
    return (await a.getStats()).size;
  });
  if (first !== 20) throw new Error(`Concurrent inserts lost: ${first}`);
  await page.reload();
  const result = await page.evaluate(async () => {
    const { CacheManager } = await import('/cache.js');
    const a = new CacheManager({ enabled: true, storage: 'indexeddb', name: 'native-cache' });
    const value = await a.get('web', 'url5');
    if (value.value !== 5 || !(value.bytes instanceof Uint8Array) || value.bytes[1] !== 255) throw new Error('Reload/binary roundtrip failed');
    try { await a.set('web', 'url5', { bad: () => {} }); throw new Error('Expected serialization rejection'); } catch (error) { if (error.message === 'Expected serialization rejection') throw error; }
    if ((await a.get('web', 'url5')).value !== 5) throw new Error('Abort lost committed value');
    await a.clear();
    const other = new CacheManager({ enabled: true, storage: 'indexeddb', name: 'native-cache:child' });
    if (await other.get('web', 'other') !== 'isolated') throw new Error('Namespace isolation failed');
    await other.clear();
    return { ok: true, concurrency: 20, reload: true, binary: true, rollback: true, namespaceIsolation: true };
  });
  console.log(JSON.stringify({ ...result, browser: await browser.version() }));
  await context.close();
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
