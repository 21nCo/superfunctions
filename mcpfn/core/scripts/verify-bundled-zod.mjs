import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const packagePath = require.resolve('zod/package.json');
const zodRoot = await realpath(dirname(packagePath));
const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
assert.equal(metadata.version, '4.6.6', 'unexpected bundled Zod build input');
for (const file of ['index.js.map', 'index.cjs.map']) {
  const mapPath = resolve(root, 'dist', file);
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  const sources = [];
  for (const [index, source] of map.sources.entries()) {
    if (!source.includes('/zod/')) continue;
    const actual = await realpath(resolve(dirname(mapPath), source));
    const within = relative(zodRoot, actual);
    assert(!within.startsWith(`..${sep}`) && within !== '..', `foreign Zod source: ${source}`);
    assert.equal(map.sourcesContent[index], await readFile(actual, 'utf8'), `embedded bytes differ: ${source}`);
    sources.push(within);
  }
  assert(sources.length > 0, 'no bundled Zod sources found');
  assert(sources.some(source => source.startsWith(`v4${sep}`)), 'missing SDK v4 runtime');
  console.log(JSON.stringify({ bundle: file, zodVersion: metadata.version, sources }));
}
