/** Reproducible V0 browser benchmarks: node scripts/benchmark.mjs. */
import os from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'chromium';
const { build } = require('esbuild');
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { contents: 'export { CacheFn, cacheFn, memoize, memoizeSync } from "./src/index.ts"', resolveDir: directory }, bundle: true, format: 'iife', globalName: 'Benchmark', platform: 'browser', write: false });
const server = createServer((_req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.end('<!doctype html><title>CacheFn benchmark</title>');
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await playwright[engine].launch({ headless: true, timeout: 30000, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    const { CacheFn, cacheFn, memoize, memoizeSync } = Benchmark;
    const count = 10000;
    const summarize = (samples, target) => {
      samples.sort((a, b) => a - b);
      const at = percentile => samples[Math.min(samples.length - 1, Math.ceil(samples.length * percentile) - 1)];
      return { samples: samples.length, p50_ms: at(.5), p95_ms: at(.95), p99_ms: at(.99), target_ms: target, pass: at(.99) < target };
    };
    const measure = async (fn, count, target) => { const samples = []; for (let i = 0; i < count; i++) { const start = performance.now(); await fn(i); samples.push(performance.now() - start); } return summarize(samples, target); };
    const output = {};
    for (const storage of ['memory', 'indexeddb']) {
      const cache = new CacheFn({ name: `benchmark-${storage}-${crypto.randomUUID()}`, storage, maxSize: count });
      for (let i = 0; i < 100; i++) await cache.set(`warm:${i}`, i);
      await cache.clear();
      output[`${storage}_set`] = await measure(i => cache.set(`key:${i}`, i), count, storage === 'memory' ? 1 : 10);
      output[`${storage}_get`] = await measure(i => cache.get(`key:${i}`), count, storage === 'memory' ? 1 : 10);
      output[`${storage}_overwrite_full`] = await measure(i => cache.set(`key:${i}`, i), count, storage === 'memory' ? 1 : 10);
      const start = performance.now();
      await Promise.all(Array.from({ length: 1000 }, (_, i) => cache.get(`key:${i}`)));
      output[`${storage}_concurrent_1000_reads`] = { elapsed_ms: performance.now() - start, operations: 1000 };
      await cache.clear(); cache.dispose();
    }
    const lru = new CacheFn({ name: 'lru-benchmark', maxSize: 1000 });
    for (let i = 0; i < 1000; i++) await lru.set(`key:${i}`, i);
    output.lru_at_1000_entries = await measure(i => lru.set(`new:${i}`, i), 1000, 5);
    const invalidations = [];
    for (let trial = 0; trial < 30; trial++) {
      for (let i = 0; i < 1000; i++) await lru.set(`pattern:${i}`, i);
      const start = performance.now(); await lru.invalidateByPattern('pattern:*'); invalidations.push(performance.now() - start);
    }
    output.pattern_invalidation_1000 = summarize(invalidations, 50);
    for (const [name, factory] of [['async', memoize], ['sync', memoizeSync], ['factory', cacheFn.memoize]]) {
      const cached = factory(value => value + 1); await cached(1);
      output[`${name}_memoized_hit`] = await measure(() => cached(1), count, .1);
      await cached.clear();
    }
    let timerResolution = Infinity; for (let i = 0; i < 10000; i++) { const before = performance.now(); const after = performance.now(); if (after > before) timerResolution = Math.min(timerResolution, after - before); }
    return { timer_resolution_ms: Number.isFinite(timerResolution) ? timerResolution : null, crossOriginIsolated, entries: count, userAgent: navigator.userAgent, timing: 'performance.now; sequential awaited operations; p99 strict target; no baseline subtraction', results: output };
  });
  if (engine === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('HeapProfiler.collectGarbage');
    const before = await session.send('Runtime.getHeapUsage');
    await page.evaluate(async () => { globalThis.heapCache = new Benchmark.CacheFn({ name: 'heap', maxSize: 10000 }); for (let i = 0; i < 10000; i++) await heapCache.set(String(i), i); });
    await session.send('HeapProfiler.collectGarbage');
    const after = await session.send('Runtime.getHeapUsage');
    const bytes = (after.usedSize - before.usedSize) / 10000;
    results.results.retained_bytes_per_numeric_entry = { bytes, target_bytes: 200, pass: bytes < 200, method: 'CDP full GC before/after, delta includes string keys, metadata, indexes, LRU, instance' };
  }
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, memoryBytes: os.totalmem(), node: process.version }, engine, browser: await browser.version(), ...results }, null, 2));
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
