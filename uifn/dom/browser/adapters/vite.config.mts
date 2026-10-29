import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

// Adapter scenarios consume the built @uifn/react, @uifn/svelte, and @uifn/solid
// packages, exactly as an application would. React resolves to the copy the
// React adapter is tested against; solid-js is deduplicated by vite-plugin-solid.
const reactFixtureRoot = path.resolve(__dirname, '../../../react/node_modules');

// @uifn/dom nests a patched svelte with its own @sveltejs/vite-plugin-svelte, apart from the
// repository-wide hoist (UIF-32). The plugin compiles with the svelte beside it, and dedupe
// resolves the runtime from here. Output from one copy cannot run on the other, so fail
// before serving if npm ever hoists either package away from the other.
const svelteFrom = (dir: string) =>
  fs.realpathSync(createRequire(path.join(dir, 'noop.js')).resolve('svelte/package.json'));
const sveltePluginDir = createRequire(__filename)
  .resolve.paths('@sveltejs/vite-plugin-svelte')
  ?.map((dir) => path.join(dir, '@sveltejs/vite-plugin-svelte'))
  .find((dir) => fs.existsSync(dir));
if (!sveltePluginDir || svelteFrom(sveltePluginDir) !== svelteFrom(__dirname)) {
  throw new Error(
    `Svelte compiler and runtime differ: the plugin at ${sveltePluginDir} compiles with ` +
      `${sveltePluginDir && svelteFrom(sveltePluginDir)}, fixtures run ${svelteFrom(__dirname)}.`,
  );
}

export default defineConfig({
  root: __dirname,
  // The 4175 server owns node_modules/.vite. A shared cache would be deleted and rewritten
  // whenever the two servers' config hashes differ.
  cacheDir: path.resolve(__dirname, '../../node_modules/.vite-adapters'),
  plugins: [
    svelte(),
    // React fixtures are .tsx too; keep them on Vite's default React JSX transform.
    solid({ exclude: [/\/browser\/adapters\/react\//] }),
  ],
  resolve: {
    alias: {
      react: path.join(reactFixtureRoot, 'react'),
      'react-dom': path.join(reactFixtureRoot, 'react-dom'),
    },
    dedupe: ['react', 'react-dom', 'svelte'],
  },
  server: { host: '127.0.0.1', port: 4176, strictPort: true },
});
