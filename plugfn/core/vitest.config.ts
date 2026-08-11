import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const plugFnCore = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const oauthProviders = fileURLToPath(
  new URL('./node_modules/@superfunctions/oauth-providers/dist/index.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      plugfn: plugFnCore,
      '@superfunctions/oauth-providers': oauthProviders,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', 'plugfn/**', 'tests/conduct/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'examples/',
        'tests/e2e/',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },
  },
});
