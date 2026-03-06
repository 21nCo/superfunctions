import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
    setupFiles: ['__tests__/setup.ts'],
  },
});
