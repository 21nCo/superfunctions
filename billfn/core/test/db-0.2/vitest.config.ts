import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Reruns the core suite with every `@superfunctions/db` import (from BillFn
 * sources and tests alike) resolved to the db 0.2.x line, proving the peer
 * range `^0.2.0 || ^0.3.0` against the lower major.
 */
const require = createRequire(import.meta.url);
const compatEntry = require.resolve('@superfunctions/db-0.2');
const compatManifest = JSON.parse(
  readFileSync(join(dirname(compatEntry), '..', 'package.json'), 'utf8')
) as { name: string; version: string };
if (compatManifest.name !== '@superfunctions/db' || !compatManifest.version.startsWith('0.2.')) {
  throw new Error(`expected @superfunctions/db-0.2 to be db 0.2.x, found ${compatManifest.name}@${compatManifest.version}`);
}

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: [{ find: /^@superfunctions\/db(\/.*)?$/, replacement: '@superfunctions/db-0.2$1' }]
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'test/db-0.2/**/*.test.ts']
  }
});
