import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const plugFnCore = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const PERFORMANCE_TESTS = 'tests/scopes/scope-performance.test.ts';

export default defineConfig({
  resolve: {
    alias: {
      plugfn: plugFnCore,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Each project names its own files: `extends: true` concatenates arrays,
    // so a root `include` would add every file to both projects.
    exclude: ['dist/**', 'node_modules/**', 'plugfn/**', 'tests/conduct/**'],
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: [PERFORMANCE_TESTS] },
      },
      {
        // Timing tests run alone, after every other file has finished (a
        // higher group order), so no CPU-heavy suite runs beside them. They
        // assert time ratios, not wall time, so a loaded host gets a longer
        // timeout instead of a spurious failure.
        extends: true,
        test: { name: 'performance', include: [PERFORMANCE_TESTS], sequence: { groupOrder: 1 }, testTimeout: 60_000 },
      },
    ],
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
