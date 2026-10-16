/** Bundle current workspace source APIs and run their actual integrations, without network services. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, readdir, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const aliases = {};
for (const group of ['packages', 'searchfn', 'authfn', 'botfn', 'cachefn']) {
  for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, group, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const source = join(directory, 'src/index.ts'); await access(source);
      aliases[manifest.name] = source;
    } catch { /* Not a workspace package with a source entry. */ }
  }
}
aliases['@superfunctions/db/testing'] = join(root, 'packages/db/src/testing/index.ts');
aliases['authfn/core/users'] = join(root, 'authfn/core/src/core/users.ts');
aliases['authfn/core/sessions'] = join(root, 'authfn/core/src/core/sessions.ts');
aliases['authfn/core/cookies'] = join(root, 'authfn/core/src/core/cookies.ts');
const temporary = await mkdtemp(join(tmpdir(), 'cachefn-ecosystem-'));
try {
  if (process.argv.includes('--typecheck')) {
    const config = join(temporary, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, strict: true, skipLibCheck: true, esModuleInterop: true, types: ['node'], typeRoots: [join(root, 'node_modules/@types'), join(root, 'cachefn/typescript/node_modules/@types')], baseUrl: root, paths: Object.fromEntries(Object.entries(aliases).map(([name, file]) => [name, [file]])) }, files: [join(root, 'cachefn/typescript/scripts/ecosystem-scenarios.ts')] }));
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], { stdio: 'inherit' });
  }
  const output = join(temporary, 'acceptance.mjs');
  await build({ entryPoints: [join(root, 'cachefn/typescript/scripts/ecosystem-scenarios.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', alias: aliases });
  await import(pathToFileURL(output).href);
} finally { await rm(temporary, { recursive: true, force: true }); }
