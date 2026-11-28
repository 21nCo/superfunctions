import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Runs the GitHub App minter suite inside workerd (Miniflare) so its
 * WebCrypto-only key import, JWT signing and fetch use are checked on the
 * Workers runtime, not only on Node. No Cloudflare account or binding is used.
 */
export default defineWorkersConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/workerd/**/*.test.ts'],
    testTimeout: 60_000,
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: {
          compatibilityDate: '2025-11-13',
        },
      },
    },
  },
});
