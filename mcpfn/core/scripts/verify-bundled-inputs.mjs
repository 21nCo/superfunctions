import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';

assert(process.argv[2] && process.argv.length <= 4, 'Usage: verify-bundled-inputs.mjs <package-root> [--seal]');
assert(process.argv[3] === undefined || process.argv[3] === '--seal', 'Unknown verifier option');
const root = realpathSync(resolve(process.argv[2]));
const seal = process.argv[3] === '--seal';
// Verification intentionally accepts extracted packages outside the checkout.
// Every file accessed must remain within that explicit root, including symlinks.
function packageFile(...parts) {
  const file = realpathSync(join(root, ...parts));
  const suffix = relative(root, file);
  assert(suffix && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\') && !isAbsolute(suffix), 'Package input escapes its root');
  return file;
}
const manifest = JSON.parse(readFileSync(packageFile('package.json')));
assert(['@mcpfn/core', '@mcpfn/auth'].includes(manifest.name), 'Only MCP core/auth bundles are supported');
const expected = {'@modelcontextprotocol/sdk': '1.32.1', zod:'4.6.6'};
assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], expected['@modelcontextprotocol/sdk']);
for (const [format, output] of [['esm','index.js'], ['cjs','index.cjs']]) {
  const path = packageFile('dist',`embedded-inputs-${format}.json`);
  const inventory = JSON.parse(readFileSync(path));
  assert.equal(inventory.schemaVersion, 1);
  for (const [name, version] of Object.entries(expected)) {
    const inputs = inventory.inputs.filter(input => input.name === name);
    assert(inputs.length > 0, `Missing bundled ${name} inventory`);
    for (const input of inputs) {
      assert.equal(input.version, version, `Unexpected bundled ${name} version`);
      assert.match(input.sha256, /^[a-f0-9]{64}$/);
    }
  }
  const sha256 = createHash('sha256').update(readFileSync(packageFile('dist',output))).digest('hex');
  if (seal) {
    inventory.output = {file:output, sha256};
    writeFileSync(path, JSON.stringify(inventory,null,2)+'\n');
  } else {
    assert.equal(inventory.output.file, output);
    assert.equal(inventory.output.sha256, sha256, 'Bundle differs from recorded build output');
  }
  console.log(JSON.stringify({package:manifest.name, format, inputs:inventory.inputs.length, versions:expected, sha256}));
}
