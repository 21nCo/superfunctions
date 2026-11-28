// The test of a product's bare (unscoped) npm package, a byte-for-byte copy of the shared template that the release
// gate checks. The release build runs it after installing the package's pinned dependencies from npm, so it proves
// the packed package against the exact published core and CLI:
//   - with exports, `import "<bare>"` gives exactly the core's exports (the core must be importable as ESM);
//   - every bin runs the CLI at exactly this package's version: `<bin> --version` prints it. npm_execpath is cleared
//     and PATH holds only Node.js, so npm cannot stand in for a missing or different installed CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packageDir = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

if (manifest.exports !== undefined) {
  test(`import "${manifest.name}" gives its core's exports`, async () => {
    const [core] = Object.keys(manifest.dependencies);
    const bare = await import(manifest.name);
    const coreModule = await import(core);
    assert.deepEqual(Object.keys(bare).sort(), Object.keys(coreModule).sort());
    for (const key of Object.keys(coreModule)) assert.equal(bare[key], coreModule[key], key);
  });
}

for (const [name, file] of Object.entries(manifest.bin ?? {})) {
  test(`${name} runs ${manifest.frontDoor.cli} at ${manifest.version}`, () => {
    const result = spawnSync(process.execPath, [path.join(packageDir, file), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: '', PATH: path.dirname(process.execPath) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), manifest.version);
  });
}
