/** Reproducible V0 browser benchmarks: node scripts/benchmark.mjs. */
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'chromium';
const { build } = require('esbuild');
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedRef = process.argv.find(value => value.startsWith('--ref='))?.slice(6);
const sourceRef = requestedRef ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`], { cwd: directory, encoding: 'utf8' }).trim() : undefined;
const plugins = sourceRef ? [{ name: 'source-snapshot', setup(builder) {
  builder.onLoad({ filter: /\.ts$/ }, args => {
    if (!args.path.startsWith(resolve(directory, 'src') + '/')) return;
    const sourcePath = `cachefn/typescript/${relative(directory, args.path)}`;
    return { contents: execFileSync('git', ['show', `${sourceRef}:${sourcePath}`], { cwd: directory, encoding: 'utf8' }), loader: 'ts', resolveDir: dirname(args.path) };
  });
} }] : [];
const bundle = await build({ plugins, stdin: { contents: 'export { CacheFn, cacheFn, memoize, memoizeSync } from "./src/index.ts"', resolveDir: directory }, bundle: true, format: 'iife', globalName: 'Benchmark', platform: 'browser', write: false });
const server = createServer((_req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.end('<!doctype html><title>CacheFn benchmark</title>');
});
let browser;
let deadline;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await playwright[engine].launch({ headless: true, timeout: 30000, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  // Closing the owned browser interrupts a stuck evaluation/IndexedDB request.
  // This bounds the whole workload without dropping slow samples.
  deadline = setTimeout(() => { void browser.close().catch(() => {}); }, 180000);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    const { CacheFn, cacheFn, memoize, memoizeSync } = Benchmark;
    const count = 10000;
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const summarize = (samples, target) => {
      samples.sort((a, b) => a - b);
      const at = percentile => samples[Math.min(samples.length - 1, Math.ceil(samples.length * percentile) - 1)];
      return { samples: samples.length, p50_ms: at(.5), p95_ms: at(.95), p99_ms: at(.99), target_ms: target, pass: at(.99) < target };
    };
    const measure = async (fn, count, target, verify) => { const samples = []; for (let i = 0; i < count; i++) { const start = performance.now(); const result = await fn(i); samples.push(performance.now() - start); verify?.(result, i); } return summarize(samples, target); };
    const output = {};
    for (const storage of ['memory', 'indexeddb']) {
      const cache = new CacheFn({ name: `benchmark-${storage}-${crypto.randomUUID()}`, storage, maxSize: count });
      for (let i = 0; i < 100; i++) await cache.set(`warm:${i}`, i);
      await cache.clear();
      output[`${storage}_set`] = await measure(i => cache.set(`key:${i}`, i), count, storage === 'memory' ? 1 : 10);
      assert(await cache.size() === count, `${storage}: populated size`);
      output[`${storage}_get`] = await measure(i => cache.get(`key:${i}`), count, storage === 'memory' ? 1 : 10,
        (value, i) => assert(value === i, `${storage}: get ${i}`));
      output[`${storage}_overwrite_full`] = await measure(i => cache.set(`key:${i}`, -i), count, storage === 'memory' ? 1 : 10);
      assert(await cache.size() === count, `${storage}: overwrite changed size`);
      for (let i = 0; i < count; i++) assert(await cache.get(`key:${i}`) === -i, `${storage}: overwritten value ${i}`);
      const start = performance.now();
      const values = await Promise.all(Array.from({ length: 1000 }, (_, i) => cache.get(`key:${i}`)));
      output[`${storage}_concurrent_1000_reads`] = { elapsed_ms: performance.now() - start, operations: 1000 };
      assert(values.every((value, i) => value === -i), `${storage}: concurrent read values`);
      if (storage === 'memory') {
        // Reestablish a known LRU order after the concurrent-read workload.
        for (let i = 0; i < count; i++) await cache.get(`key:${i}`);
        output.memory_new_keys_at_10000_capacity = await measure(i => cache.set(`new:${i}`, i), count, 1);
        assert(await cache.size() === count, 'memory: capacity was not retained');
        for (let i = 0; i < count; i++) {
          assert(!await cache.has(`key:${i}`), `memory: old key ${i} not evicted`);
          assert(await cache.get(`new:${i}`) === i, `memory: replacement ${i} missing`);
        }
      } else {
        // Exercise the matching scan at the original 10,000-entry population,
        // retaining 9,000 nonmatching records while deleting exactly 1,000.
        const invalidations = [];
        for (let trial = 0; trial < 30; trial++) {
          assert(await cache.size() === count, 'full IndexedDB invalidation: population');
          const start = performance.now();
          await cache.invalidateByPattern(/^key:1[0-9]{3}$/);
          invalidations.push(performance.now() - start);
          assert(await cache.size() === 9000, 'full IndexedDB invalidation: retained count');
          assert(await cache.get('key:0') === 0 && await cache.get('key:9999') === -9999, 'full IndexedDB invalidation: unrelated values');
          for (let i = 1000; i < 2000; i++) {
            assert(!await cache.has(`key:${i}`), `full IndexedDB invalidation: key ${i} retained`);
            await cache.set(`key:${i}`, -i);
          }
        }
        output.indexeddb_pattern_invalidation_1000_of_10000 = summarize(invalidations, 50);
      }
      await cache.clear();
      if (storage === 'indexeddb') {
        const invalidations = [];
        for (let trial = 0; trial < 30; trial++) {
          for (let i = 0; i < 1000; i++) await cache.set(`pattern:${i}`, i);
          assert((await cache.keys('pattern:*')).length === 1000, 'IndexedDB invalidation: incomplete population');
          const start = performance.now();
          await cache.invalidateByPattern('pattern:*');
          invalidations.push(performance.now() - start);
          assert(await cache.size() === 0, 'IndexedDB invalidation: matching keys retained');
        }
        output.indexeddb_pattern_invalidation_1000 = summarize(invalidations, 50);
      }
      cache.dispose();
    }
    const lru = new CacheFn({ name: 'lru-benchmark', maxSize: 1000 });
    for (let i = 0; i < 1000; i++) await lru.set(`key:${i}`, i);
    output.lru_at_1000_entries = await measure(i => lru.set(`new:${i}`, i), 1000, 5);
    assert(await lru.size() === 1000, 'LRU: size after replacement');
    for (let i = 0; i < 1000; i++) {
      assert(!await lru.has(`key:${i}`), `LRU: victim ${i} retained`);
      assert(await lru.get(`new:${i}`) === i, `LRU: replacement ${i} missing`);
    }
    const invalidations = [];
    for (let trial = 0; trial < 30; trial++) {
      for (let i = 0; i < 1000; i++) await lru.set(`pattern:${i}`, i);
      assert((await lru.keys('pattern:*')).length === 1000, 'invalidation: incomplete population');
      const start = performance.now(); await lru.invalidateByPattern('pattern:*'); invalidations.push(performance.now() - start);
      assert(await lru.size() === 0, 'invalidation: matching keys retained');
    }
    output.pattern_invalidation_1000 = summarize(invalidations, 50);
    lru.dispose();
    for (const [name, factory] of [['async', memoize], ['sync', memoizeSync], ['factory', cacheFn.memoize]]) {
      const cached = factory(value => value + 1); await cached(1);
      output[`${name}_memoized_hit`] = await measure(() => cached(1), count, .1,
        value => assert(value === 2, `${name}: memoized result`));
      await cached.clear();
    }
    let timerResolution = Infinity; for (let i = 0; i < 10000; i++) { const before = performance.now(); const after = performance.now(); if (after > before) timerResolution = Math.min(timerResolution, after - before); }
    return { timer_resolution_ms: Number.isFinite(timerResolution) ? timerResolution : null, crossOriginIsolated, entries: count, userAgent: navigator.userAgent, timing: 'performance.now; sequential awaited operations; p99 strict target; no baseline subtraction', results: output };
  });
  if (engine === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('HeapProfiler.collectGarbage');
    const before = await session.send('Runtime.getHeapUsage');
    await page.evaluate(async () => {
      globalThis.heapCache = new Benchmark.CacheFn({ name: 'heap', maxSize: 10000 });
      for (let i = 0; i < 10000; i++) await heapCache.set(String(i), i);
      if (await heapCache.size() !== 10000) throw new Error('Heap fixture must retain all 10000 entries');
    });
    await session.send('HeapProfiler.collectGarbage');
    const after = await session.send('Runtime.getHeapUsage');
    const bytes = (after.usedSize - before.usedSize) / 10000;
    results.results.retained_bytes_per_numeric_entry = { bytes, target_bytes: 200, pass: Number.isFinite(bytes) && bytes > 0 && bytes < 200, method: 'CDP full GC before/after, delta includes string keys, metadata, indexes, LRU, instance' };
  }
  const failures = Object.entries(results.results).filter(([, result]) => result.pass === false).map(([name]) => name);
  const memoryMeasured = engine === 'chromium';
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), source_ref: sourceRef ?? 'working-tree', benchmark_sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), source_bundle_sha256: createHash('sha256').update(bundle.outputFiles[0].text).digest('hex'), host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, memoryBytes: os.totalmem(), node: process.version }, engine, browser: await browser.version(), ...results, correctness: 'all populated sizes, read values, overwrites, eviction victims, replacement values, invalidation counts and memoized values asserted outside timed samples', failures, memory_measured: memoryMeasured, all_targets_pass: failures.length === 0 && memoryMeasured }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
