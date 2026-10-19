import { defineConfig } from 'vitest/config';

// Integration tests depend on several private packages and are owned here.
export default defineConfig({ test: { fileParallelism: false, include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'] } });
