import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Integration against repository source, not AuthFn's older published dependency closure.
export default defineConfig({
  resolve: { alias: [
    { find: /^authfn$/, replacement: source('../../authfn/core/src/index.ts') },
    { find: /^authfn\/(.*)$/, replacement: source('../../authfn/core/src/') + '$1.ts' },
    { find: '@superfunctions/http-openapi', replacement: source('../../packages/http-openapi/src/index.ts') },
    { find: '@superfunctions/oauth-storage', replacement: source('../../packages/oauth-storage/src/index.ts') },
    { find: /^@superfunctions\/http$/, replacement: source('../../packages/http/src/index.ts') },
    { find: /^@superfunctions\/db$/, replacement: source('../../packages/db/src/index.ts') },
  ] },
  test: { include: ['tests/authfn-acceptance.test.ts'], testTimeout: 15000 },
});
