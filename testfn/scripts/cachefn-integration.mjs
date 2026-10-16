/** Build and pack an isolated copy of CacheFn, leaving its checkout untouched. */
import { mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const cacheRoot = process.env.CACHEFN_ROOT;
if (!cacheRoot)
  throw Error("Set CACHEFN_ROOT to the CacheFn repository checkout");
const directory = mkdtempSync(join(tmpdir(), "testfn-cachefn-"));
const run = (command, args, cwd = directory) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  const copy = join(directory, "cache-source");
  cpSync(join(cacheRoot, "cachefn/typescript"), copy, {
    recursive: true,
    filter: (path) =>
      !["node_modules", "dist", ".conduct", "_conduct"].includes(
        basename(path),
      ),
  });
  run(
    "npx",
    [
      "--yes",
      "npm@11.21.0",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    copy,
  );
  run("npm", ["run", "build"], copy);
  const dependencies = {};
  for (const source of [
    copy,
    join(root, "packages/observability"),
    join(root, "packages/db"),
    join(root, "testfn/typescript"),
  ]) {
    const [pack] = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
        source,
      ),
    );
    dependencies[pack.name] = `file:${join(directory, pack.filename)}`;
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      devDependencies: { vitest: process.env.TESTFN_VITEST_VERSION ?? "3.2.7" },
    }),
  );
  run("npx", [
    "--yes",
    "npm@11.21.0",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  writeFileSync(
    join(directory, "vitest.config.mjs"),
    `export default {test:{include:['cache.integration.test.js'],maxWorkers:1}};`,
  );
  writeFileSync(
    join(directory, "cache.integration.test.js"),
    `import {test,expect} from 'vitest';import {cacheFn,memoize} from '@cachefn/core';
test('cache storage tags and TTL',async()=>{const cache=cacheFn({name:'testfn-integration',storage:'memory'});await cache.set('user:1',{name:'Ada'},{tags:['users']});expect(await cache.get('user:1')).toEqual({name:'Ada'});await cache.invalidateByTag('users');expect(await cache.has('user:1')).toBe(false);await cache.set('expires','value',{ttl:10});await new Promise(r=>setTimeout(r,30));expect(await cache.has('expires')).toBe(false);});
test('memoization coalesces actual asynchronous calls',async()=>{let calls=0;const fn=memoize(async value=>{calls++;await new Promise(r=>setTimeout(r,10));return value*2;},{storage:'memory'});expect(await Promise.all([fn(4),fn(4)])).toEqual([8,8]);expect(calls).toBe(1);await fn.clear();expect(await fn(4)).toBe(8);expect(calls).toBe(2);});`,
  );
  writeFileSync(
    join(directory, "acceptance.mjs"),
    `import assert from 'node:assert/strict';import {testFn,TestStorage,JsonReporter} from '@testfn/core';import {readFileSync} from 'node:fs';const run=await testFn({framework:'vitest',testPattern:'cache.integration.test.js',parallel:1,timeout:30000,reporters:[new JsonReporter('results.json')],storage:{type:'file',dbName:'history'}}).run();assert.equal(run.summary.total,2,JSON.stringify(run));assert.equal(run.summary.passed,2,JSON.stringify(run));assert.equal(JSON.parse(readFileSync('results.json')).results.length,2);const storage=new TestStorage({type:'file',dbName:'history'});await storage.open();assert.equal((await storage.getRun(run.id)).summary.passed,2);assert.equal((await storage.getTestHistory(run.results[0].id,10)).length,1);await storage.close();console.log(JSON.stringify({cachefn:'0.0.3',testfn:'0.0.4',assertions:5,summary:run.summary}));`,
  );
  console.log(run(process.execPath, ["acceptance.mjs"]));
  console.log("Isolated consumer retained:", directory);
} catch (error) {
  console.error("Isolated consumer retained:", directory);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
}
