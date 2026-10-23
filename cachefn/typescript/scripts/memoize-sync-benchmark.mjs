/** Populated synchronous memoization benchmark; run from any directory. */
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { build } = require('esbuild');
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.env.BROWSER_ENGINE || 'chromium';
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) || 'current';
const workload = process.argv.includes('--replacement') ? 'replacement' : 'hit';
const sourceRef = process.argv.find(value => value.startsWith('--ref='))?.slice(6);
const sourcePath = resolve(directory, 'src/memoization/memoize.ts');
const source = sourceRef ? execFileSync('git', ['show', `${sourceRef}:cachefn/typescript/src/memoization/memoize.ts`], { cwd: directory, encoding: 'utf8' }) : await readFile(sourcePath, 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const bundle = await build({ plugins: [{ name: 'memoize-source-snapshot', setup(builder) { builder.onLoad({ filter: /memoization\/memoize\.ts$/ }, args => args.path === sourcePath ? { contents: source, loader: 'ts', resolveDir: dirname(sourcePath) } : undefined); } }], stdin: { contents: 'export { memoizeSync } from "./src/memoization/memoize.ts"', resolveDir: directory }, bundle: true, format: 'iife', globalName: 'MemoizeBenchmark', platform: 'browser', write: false });
const server = createServer((_request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.end('<!doctype html><title>Populated memoizeSync benchmark</title>');
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await playwright[engine].launch({ headless: true, timeout: 30000, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async (workload) => {
    const samplesPerCase = 20000, warmupHits = 2000;
    const results = [];
    for (const keyMode of ['custom', 'default']) for (const ttl of [undefined, 3600000]) for (const population of [1, 1000, 10000]) {
      let computations = 0;
      const options = { maxSize: population, ttl, ...(keyMode === 'custom' ? { keyGenerator: value => String(value) } : {}) };
      const cached = MemoizeBenchmark.memoizeSync(value => { computations++; return value + 1; }, options);
      const seedStarted = performance.now();
      for (let i = 0; i < population; i++) cached(i);
      const seedMs = performance.now() - seedStarted;
      for (let i = 0; i < warmupHits; i++) cached(i % population);
      const samples = []; let checksum = 0;
      for (let i = 0; i < samplesPerCase; i++) {
        const key = workload === 'replacement' ? population + i : i % population, before = performance.now();
        const value = cached(key);
        samples.push(performance.now() - before); checksum += value;
      }
      const stats = await cached.stats();
      const replacing = workload === 'replacement';
      if (computations !== population + (replacing ? samplesPerCase : 0) || stats.size !== population || stats.hits !== warmupHits + (replacing ? 0 : samplesPerCase) || stats.evictions !== (replacing ? samplesPerCase : 0)) throw Error('Benchmark workload did not retain expected capacity/hits/evictions');
      const expectedChecksum = replacing ? samplesPerCase * (2 * population + samplesPerCase + 1) / 2 : Array.from({ length: samplesPerCase }, (_, i) => i % population + 1).reduce((a, b) => a + b, 0);
      if (checksum !== expectedChecksum) throw Error('Benchmark returned incorrect values');
      samples.sort((a, b) => a - b);
      const quantile = fraction => samples[Math.ceil(samples.length * fraction) - 1];
      results.push({ population, keyMode, ttl_ms: ttl ?? null, samples: samples.length, warmupHits, seed_ms: seedMs, p50_ms: quantile(.5), p95_ms: quantile(.95), p99_ms: quantile(.99), maximum_ms: samples.at(-1), mean_ms: samples.reduce((sum, value) => sum + value, 0) / samples.length, target_ms: replacing ? null : .1, p99_pass: replacing ? null : quantile(.99) < .1, computations, checksum, stats });
      await cached.clear();
    }
    let timerResolution = Infinity;
    for (let i = 0; i < 10000; i++) { const before = performance.now(), after = performance.now(); if (after > before) timerResolution = Math.min(timerResolution, after - before); }
    return { timer_resolution_ms: Number.isFinite(timerResolution) ? timerResolution : null, crossOriginIsolated, userAgent: navigator.userAgent, results };
  }, workload);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), label, workload, sourceRef: sourceRef ?? 'working-tree', sourceSha256, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, node: process.version }, engine, browser: await browser.version(), timing: 'performance.now around synchronous call; selected populated hit or full-capacity replacement workload; no await or baseline subtraction; isolated page; population asserted', ...results }, null, 2));
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
