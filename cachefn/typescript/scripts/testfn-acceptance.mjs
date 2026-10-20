/** Actual TestFn -> installed Vitest -> CacheFn fixture lifecycle. Build both packages first. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const directory = await realpath(process.env.CACHEFN_CONSUMER_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const consumerRequire = createRequire(join(directory, 'package.json'));
const modulePath = process.env.CACHEFN_CONSUMER_ROOT ? consumerRequire.resolve('@testfn/core') : process.env.CACHEFN_TESTFN_CORE || resolve(directory, '../../testfn/typescript/dist/index.js');
const cachePath = process.env.CACHEFN_CONSUMER_ROOT ? consumerRequire.resolve('@cachefn/core') : join(directory, 'dist/index.js');
if (process.env.CACHEFN_CONSUMER_ROOT) {
  for (const path of [modulePath, cachePath, consumerRequire.resolve('vitest/package.json')]) assert.ok((await realpath(path)).startsWith(join(directory, 'node_modules') + '/'), `Dependency must resolve inside the fresh consumer: ${path}`);
}
const { testFn } = await import(pathToFileURL(modulePath).href);
const temporary = await mkdtemp(join(directory, '.testfn-acceptance-'));
const originalCwd = process.cwd();
try {
  process.chdir(directory);
  const receipt = join(temporary, 'cleanup.json');
  const passing = join(temporary, 'fixtures.test.mjs');
  await writeFile(passing, `
import { beforeAll, afterAll, test, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { cacheFn } from ${JSON.stringify(pathToFileURL(cachePath).href)};
const cache = cacheFn({name:'testfn-fixtures',storage:'memory',maxSize:100});
let loads=0;
const fixture=()=>cache.getOrFetch('dataset',async()=>{loads++;return [{id:1,name:'fixture'}]});
beforeAll(async()=>{await fixture()});
test('reuses the prepared fixture',async()=>{expect(await fixture()).toEqual([{id:1,name:'fixture'}]);expect(loads).toBe(1)});
test('shares the fixture with concurrent consumers',async()=>{expect((await Promise.all([fixture(),fixture()])).length).toBe(2);expect(loads).toBe(1)});
afterAll(async()=>{await cache.clear();await writeFile(${JSON.stringify(receipt)},JSON.stringify({size:await cache.size(),loads}));cache.dispose()});
`);
  const run = file => testFn({framework:'vitest',testPattern:file,parallel:1,timeout:15000,retries:0,reporters:[]}).run();
  const success = await run(passing);
  assert.equal(success.summary.failed, 0, JSON.stringify(success.results));
  assert.equal(success.summary.passed, 2, JSON.stringify(success.results));
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), {size:0,loads:1});
  const failedReceipt = join(temporary, 'failed-cleanup.json');
  const failing = join(temporary, 'failure.test.mjs');
  await writeFile(failing, `
import { beforeAll, afterAll, test, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { cacheFn } from ${JSON.stringify(pathToFileURL(cachePath).href)};
const cache=cacheFn({name:'failing-fixture',storage:'memory'});
beforeAll(async()=>{await cache.set('fixture',1)});
test('intentional failure reaches the runner',async()=>{expect(await cache.get('fixture')).toBe(2)});
afterAll(async()=>{await cache.clear();await writeFile(${JSON.stringify(failedReceipt)},JSON.stringify({size:await cache.size()}));cache.dispose()});
`);
  const failure = await run(failing);
  assert.equal(failure.summary.failed,1,JSON.stringify(failure.results));
  assert.equal(failure.summary.passed,0);
  assert.match(failure.results.find(result=>result.status==='failed').error.message,/expected 1 to be 2/i);
  assert.deepEqual(JSON.parse(await readFile(failedReceipt,'utf8')),{size:0});
  console.log('Actual TestFn/Vitest acceptance passed: cached fixture reuse, concurrent consumers, cleanup after success/failure, and intentional assertion failure propagation');
} finally {
  process.chdir(originalCwd);
  await rm(temporary,{recursive:true,force:true});
}
