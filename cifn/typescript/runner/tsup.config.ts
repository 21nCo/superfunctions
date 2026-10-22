import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  // LogFn is ESM-only; bundle the logger for the runner's CJS entry.
  noExternal: ['@logfn/core'],
  splitting: false,
  sourcemap: true,
  clean: true,
});
