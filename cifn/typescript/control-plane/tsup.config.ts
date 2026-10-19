import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  noExternal: ['@superfunctions/http', '@superfunctions/observability', '@superfunctions/envelope', '@superfunctions/errors', '@superfunctions/webhooks', '@superfunctions/queue'],
  splitting: false,
  sourcemap: true,
  clean: true,
});
