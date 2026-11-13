import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Workers test. The test runs in Node: it bundles worker.ts with wrangler's
 * deploy bundler and serves the bundle from workerd through Miniflare.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/workers/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
