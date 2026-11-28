import { defineConfig } from 'vitest/config';

/** Bundled Chromium contract tests. Install the browser with `npx playwright install chromium`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.browser.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
});
