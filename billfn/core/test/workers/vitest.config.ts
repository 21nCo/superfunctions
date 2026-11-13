import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Workers smoke test. The test itself runs in Node: it bundles worker.ts with
 * wrangler (the `wrangler deploy` bundler, including its Node.js compatibility
 * polyfills) and serves the bundle from workerd through Miniflare. No
 * Cloudflare account or network is used.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['test/workers/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000
  }
});
