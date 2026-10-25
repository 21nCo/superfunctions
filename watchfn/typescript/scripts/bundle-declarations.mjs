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
// Build both graphs from untouched tsup declarations. Modern compilers retain
// upstream Zod identity; TS5.0-5.3 use reachable classic declarations without the
// unused free refine() helper requiring NoInfer. Core stays external in that
// graph so brands and registry metadata retain their upstream identities.
const declarations = [];
for (const modern of [true, false]) {
  const prefix = modern ? 'modern/' : '';
  const bundle = await rollup({
    input,
    external: id => !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('@superfunctions/') && !id.startsWith('@logfn/')
      && (modern || (id !== 'zod' && !id.startsWith('zod/'))),
    plugins: [...(modern ? [] : [{
      name: 'zod-core-type-identity',
      resolveId(source, importer) {
        if (importer?.includes('/zod/v4/') && /^\.\.\/core\/index\.(?:cjs|js)$/.test(source)) {
          return { id: 'zod/v4/core', external: true };
        }
      },
    }]), dts({ respectExternal: true })],
  });
  try {
    for (const extension of ['ts', 'mts']) {
      const { output } = await bundle.generate({ format: 'es',
        entryFileNames: `${prefix}[name].d.${extension}`,
        chunkFileNames: `${prefix}shared/[name]-[hash].d.${extension}` });
      for (const chunk of output) {
        if (chunk.type !== 'chunk') throw new Error('Unexpected declaration asset');
        declarations.push([chunk.fileName, chunk.code]);
      }
    }
  } finally { await bundle.close(); }
}
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
for (const prefix of ['', 'modern/']) {
  for (const extension of ['ts', 'mts']) {
    const path = join(root, `dist/${prefix}index.d.${extension}`);
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
}
console.log(`Bundled modern and TS5.0-compatible declarations for ${Object.keys(input).length} entry points`);
