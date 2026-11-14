import { configDefaults, defineConfig } from 'vitest/config';

// Default (Node) run. tests/workers carries its own config (bundles a Worker and serves it from workerd).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [...configDefaults.exclude, 'tests/workers/**'],
  },
});
