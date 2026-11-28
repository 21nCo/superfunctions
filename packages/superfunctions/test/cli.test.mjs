import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packageDir = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

// Every bin runs the installed @superfunctions/cli, which reports its own version: the pinned one.
for (const [name, file] of Object.entries(manifest.bin)) {
  test(`${name} runs @superfunctions/cli at ${manifest.version}`, () => {
    // npm_execpath is cleared so a missing CLI fails here rather than being fetched.
    const result = spawnSync(process.execPath, [path.join(packageDir, file), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: '', PATH: path.dirname(process.execPath) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), manifest.version);
  });
}

test('the CLI is a dependency at exactly this version, and nothing else is', () => {
  assert.deepEqual(manifest.dependencies, { '@superfunctions/cli': manifest.version });
  assert.equal(manifest.exports, undefined);
  assert.equal(manifest.main, undefined);
});
