import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSharedUsage } from './check-shared-usage.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shared-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const dir of ['langfn/typescript', 'langfn/python']) mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}
for (const [file, source] of [
  ['langfn/typescript/client.ts', 'import { request } from "@superfunctions/http";'],
  ['langfn/python/client.py', 'from superfunctions.http import Request'],
]) test(`recognizes shared usage in ${file}`, t => {
  const root = fixture(t);
  writeFileSync(path.join(root, file), source);
  assert.equal(checkSharedUsage(root).file, file);
});
test('does not count ignored dependencies, binaries, or symbolic links', t => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(path.join(root, 'langfn/typescript/node_modules'), { recursive: true });
  writeFileSync(path.join(root, 'langfn/typescript/node_modules/import.js'), '@superfunctions/http');
  writeFileSync(path.join(root, 'langfn/python/binary.bin'), Buffer.from('\0superfunctions.http'));
  writeFileSync(path.join(root, 'outside.txt'), '@superfunctions/http');
  symlinkSync('../../outside.txt', path.join(root, 'langfn/typescript/link'));
  writeFileSync(path.join(root, 'langfn/python/no_import.py'), 'print("hello")');
  assert.throws(() => checkSharedUsage(root), /No shared superfunctions usage.*1 text files scanned/);
});
test('CLI fails with actionable missing directory diagnostics', t => {
  const root = fixture(t);
  rmSync(path.join(root, 'langfn/python'), { recursive: true });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-shared-usage.mjs', import.meta.url))], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /langfn\/python/);
  assert.match(result.stderr, /ENOENT/);
});
test('runs without ripgrep on PATH', t => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'langfn/python/client.py'), 'from superfunctions.http import Request');
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(git, path.join(bin, 'git'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-shared-usage.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('skips tracked files deleted from the working tree before valid source', t => {
  const root = fixture(t);
  const deleted = path.join(root, 'langfn/python/a_deleted.py');
  writeFileSync(deleted, 'print("old")');
  writeFileSync(path.join(root, 'langfn/python/z_valid.py'), 'from superfunctions.http import Request');
  execFileSync('git', ['add', '.'], { cwd: root });
  rmSync(deleted);
  assert.equal(checkSharedUsage(root).file, 'langfn/python/z_valid.py');
});
