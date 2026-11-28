import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Chromium contract tests run with `npm run test:browser`.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.browser.test.ts'],
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
      tsconfig: './tsconfig.typecheck.json'
    }
  }
});
