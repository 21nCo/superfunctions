import { defineConfig } from 'vitest/config';

// Explicit acceptance gate requiring the matching Firefox and WebKit installations.
export default defineConfig({ test: { fileParallelism: false, include: ['packages/browser-runner/test/browser-engine-matrix.acceptance.ts'] } });
