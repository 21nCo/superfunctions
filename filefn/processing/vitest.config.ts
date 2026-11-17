import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The container entry is its own workspace (@filefn/processing-container) with its own suite.
    exclude: [...configDefaults.exclude, 'container/**'],
  },
});
