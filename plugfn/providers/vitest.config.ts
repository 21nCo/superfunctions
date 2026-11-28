import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // tests/workerd runs under workerd through vitest.workerd.config.ts.
    exclude: ['dist/**', 'node_modules/**', 'tests/workerd/**'],
  },
});
