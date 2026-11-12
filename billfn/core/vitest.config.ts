import { defineConfig } from 'vitest/config';

// Default (Node, db 0.3) run. test/db-0.2 and test/workers carry their own configs.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  }
});
