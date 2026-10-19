import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export default defineConfig({
  resolve: { alias: {
    // Resolve the same transport copy as the shared package for test-only mocks.
    undici: createRequire(new URL('../../packages/webhooks/package.json', import.meta.url)).resolve('undici'),
    '@superfunctions/webhooks': fileURLToPath(new URL('../../packages/webhooks/src/index.ts', import.meta.url)),
  } },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      provider: 'v8',
    },
  },
});
