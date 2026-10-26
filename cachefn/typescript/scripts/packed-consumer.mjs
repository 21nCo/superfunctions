/** Validate the actual npm artifact in isolated ESM/CommonJS consumers.
 * Optional argument: absolute path to another TypeScript compiler's tsc.js.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const compiler = process.argv[2] ?? require.resolve('typescript/bin/tsc');
const consumer = mkdtempSync(join(tmpdir(), 'cachefn-package-consumer-'));
const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', consumer], packageDirectory));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'cachefn-packed-consumer', version: '1.0.0', private: true }));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(consumer, packed.filename)]);
  const source = `import { cacheFn } from '@cachefn/core';
const cache = cacheFn<{ 'user:*': { name: string }; 'post:*': { title: string } }>({ name: 'packed-schema' });
const user: Promise<{ name: string } | undefined> = cache.get('user:1');
cache.set('user:1', { name: 'Alice' });
// @ts-expect-error Reject a value for another schema key.
cache.set('user:1', { title: 'wrong' });
// @ts-expect-error Reject unknown keys.
cache.get('unknown:1');
void user;
`;
  for (const extension of ['mts', 'cts']) writeFileSync(join(consumer, `consumer.${extension}`), source);
  const version = run(process.execPath, [compiler, '--version']).trim();
  for (const mode of ['NodeNext', 'Node16']) {
    run(process.execPath, [compiler, '--strict', '--noEmit', '--skipLibCheck', '--module', mode, '--moduleResolution', mode, '--target', 'ES2021', 'consumer.mts', 'consumer.cts']);
    console.log(`${version}: packed .mts/.cts schema consumers passed (${mode})`);
  }
  run(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import { cacheFn } from '@cachefn/core'; const cache=cacheFn({name:'esm'}); await cache.set('key',42); assert.equal(await cache.get('key'),42);`]);
  run(process.execPath, ['-e', `const assert=require('node:assert/strict'); const {cacheFn}=require('@cachefn/core'); (async()=>{const cache=cacheFn({name:'cjs'}); await cache.set('key',42); assert.equal(await cache.get('key'),42)})().catch(error=>{console.error(error);process.exitCode=1});`]);
  run(process.execPath, ['--input-type=module', '-e', `
    import ${JSON.stringify(require.resolve('fake-indexeddb/auto'))};
    import assert from 'node:assert/strict';
    import {CacheFn} from '@cachefn/core';
    const cache=new CacheFn({name:'packed-auto-bulk',storage:'auto'});
    await cache.set('match',1); await cache.set('keep',2);
    await cache.invalidateByPattern('match');
    assert.equal(await cache.get('match'),undefined); assert.equal(await cache.get('keep'),2);
    let events=0; cache.on('delete',()=>events++); cache.on('invalidate',()=>events++);
    const original=IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear=function(){const request=original.call(this);request.addEventListener('success',()=>this.transaction.abort());return request;};
    try {await assert.rejects(cache.invalidateByPattern('*'),/aborted/);} finally {IDBObjectStore.prototype.clear=original;}
    assert.equal(events,0); assert.equal(await cache.get('keep'),2);
    await cache.invalidateByPattern('*'); assert.equal(await cache.size(),0); cache.dispose();
  `]);
  console.log('Packed auto IndexedDB bulk commit/abort and retained-tier contracts passed (fake-indexeddb)');
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  if (!lock.packages['node_modules/@cachefn/core'].resolved.startsWith('file:')) throw new Error('Expected the local tarball');
  console.log('Packed ESM/CommonJS runtime smoke passed using the local tarball');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
