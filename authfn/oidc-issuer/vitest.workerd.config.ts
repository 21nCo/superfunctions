import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Runs the OIDC issuer suite inside workerd (Miniflare) so the WebCrypto-only contract is checked on the Workers
 * runtime, not only on Node. No Cloudflare account or binding is used.
 */
export default defineWorkersConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/__tests__/workerd/**/*.test.ts'],
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
