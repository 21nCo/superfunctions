import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2]);
const seal = process.argv[3] === '--seal';
const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
const expected = {'@modelcontextprotocol/sdk': '1.32.1', zod:'4.6.6'};
assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], expected['@modelcontextprotocol/sdk']);
for (const [format, output] of [['esm','index.js'], ['cjs','index.cjs']]) {
  const path = join(root,'dist',`embedded-inputs-${format}.json`);
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
  const sha256 = createHash('sha256').update(readFileSync(join(root,'dist',output))).digest('hex');
  if (seal) {
    inventory.output = {file:output, sha256};
    writeFileSync(path, JSON.stringify(inventory,null,2)+'\n');
  } else {
    assert.equal(inventory.output.file, output);
    assert.equal(inventory.output.sha256, sha256, 'Bundle differs from recorded build output');
  }
  console.log(JSON.stringify({package:manifest.name, format, inputs:inventory.inputs.length, versions:expected, sha256}));
}
