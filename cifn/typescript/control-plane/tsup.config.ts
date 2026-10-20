import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  banner: ({ format }) => format === 'esm'
    ? { js: "import { createRequire as __cifnCreateRequire } from 'node:module'; const require = __cifnCreateRequire(import.meta.url);" }
    : undefined,
  noExternal: ['@superfunctions/http', '@superfunctions/observability', '@superfunctions/envelope', '@superfunctions/errors', '@superfunctions/webhooks', '@superfunctions/queue', '@superfunctions/db/schema'],
  external: ['better-sqlite3', 'kysely', '@superfunctions/db/adapters'],
  splitting: false,
  sourcemap: true,
  clean: true,
});
