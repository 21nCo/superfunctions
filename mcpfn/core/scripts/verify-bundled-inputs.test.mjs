import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const verifier = fileURLToPath(new URL('./verify-bundled-inputs.mjs', import.meta.url));
function fixture(fn) {
  const parent = mkdtempSync(join(tmpdir(), 'mcp-input-boundary-'));
  const root = join(parent, 'package');
  mkdirSync(join(root, 'dist'), {recursive: true});
  writeFileSync(join(root, 'package.json'), JSON.stringify({name:'@mcpfn/core', dependencies:{'@modelcontextprotocol/sdk':'1.32.1'}}));
  for (const [format, file] of [['esm','index.js'], ['cjs','index.cjs']]) {
    writeFileSync(join(root, 'dist', file), 'bundle');
    writeFileSync(join(root, 'dist', `embedded-inputs-${format}.json`), JSON.stringify({
      schemaVersion:1,
      inputs:[{name:'@modelcontextprotocol/sdk',version:'1.32.1',sha256:'a'.repeat(64)}, {name:'zod',version:'4.6.6',sha256:'b'.repeat(64)}],
      output:{file,sha256:createHash('sha256').update('bundle').digest('hex')},
    }));
  }
  const run = (...args) => spawnSync(process.execPath, [verifier, root, ...args], {encoding:'utf8'});
  try { fn({parent, root, run}); } finally { rmSync(parent, {recursive:true,force:true}); }
}
test('verifies extracted package outside checkout and seals existing inventory', () => fixture(({run}) => {
  assert.equal(run().status, 0);
  assert.equal(run('--seal').status, 0);
  assert.equal(run().status, 0);
  assert.notEqual(run('--unknown').status, 0);
}));
for (const file of ['package.json', 'dist/index.js', 'dist/embedded-inputs-esm.json']) {
  test(`rejects escaping symlink for ${file}, including seal mode`, () => fixture(({parent,root,run}) => {
    const outside = join(parent,'outside');
    writeFileSync(outside, 'do not read or overwrite');
    rmSync(join(root,file));
    symlinkSync(outside, join(root,file));
    for (const args of [[], ['--seal']]) {
      const result = run(...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Package input escapes its root/);
    }
  }));
}
