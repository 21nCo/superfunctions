import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const input = Object.fromEntries(Object.values(manifest.exports).map(entry => [
  entry.require.types.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, ''),
  join(root, entry.require.types),
]));
// One graph preserves class identity across the root and adapter subpaths.
// Bundle actual shared declarations to avoid CJS imports of ESM-only packages.
const bundle = await rollup({
  input,
  external: id => !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('@superfunctions/'),
  plugins: [dts({ respectExternal: true })],
});
const declarations = [];
try {
  for (const extension of ['ts', 'mts']) {
    const { output } = await bundle.generate({ format: 'es',
      entryFileNames: `[name].d.${extension}`, chunkFileNames: `shared/[name]-[hash].d.${extension}` });
    for (const chunk of output) {
      if (chunk.type !== 'chunk') throw new Error('Unexpected declaration asset');
      declarations.push([chunk.fileName, chunk.code]);
    }
  }
} finally { await bundle.close(); }
// Finish all reads before replacing outputs; tsup shares declaration chunks.
async function removeDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeDeclarations(path);
    else if (/\.d\.(?:ts|mts|cts)$/.test(entry.name)) await unlink(path);
  }
}
await removeDeclarations(join(root, 'dist'));
for (const [path, code] of declarations) {
  const destination = join(root, 'dist', path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, code);
}
// Keep the public root self-contained. TypeScript 5.0 cannot always name
// inferred return types re-exported through a private shared chunk. Adapters
// already reference public root identities in the multi-entry graph above.
for (const extension of ['ts', 'mts']) {
  const path = join(root, `dist/index.d.${extension}`);
  const rootBundle = await rollup({ input: path,
    external: id => !id.startsWith('.') && !isAbsolute(id),
    plugins: [dts({ respectExternal: true })],
  });
  try {
    const { output } = await rootBundle.generate({ format: 'es' });
    if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('Expected a single public declaration entry');
    await writeFile(path, output[0].code);
  } finally { await rootBundle.close(); }
}
console.log(`Bundled declarations for ${Object.keys(input).length} entry points`);
