import { defineConfig } from 'tsup';
import esbuildSvelte from 'esbuild-svelte';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ['svelte', '@docsfn/core', '@uifn/svelte', 'searchfn', 'marked'],
  esbuildPlugins: [esbuildSvelte()],
});
