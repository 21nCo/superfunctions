import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const reactFixturePaths = { paths: [path.resolve('../react')] };
const reactFixtureRoot = path.dirname(require.resolve('react/package.json', reactFixturePaths));
const reactDomFixtureRoot = path.dirname(require.resolve('react-dom/package.json', reactFixturePaths));

export default defineConfig({
  // Scan only the primitive harness; browser/adapters has its own server and dependency cache.
  optimizeDeps: { entries: ['browser/index.html'] },
  resolve: {
    alias: {
      react: reactFixtureRoot,
      'react-dom': reactDomFixtureRoot,
    },
    dedupe: ['react', 'react-dom'],
  },
});
