import path from 'node:path';
import { defineConfig } from 'vite';

const reactFixtureRoot = path.resolve('../react/node_modules');

export default defineConfig({
  // Scan only the primitive harness; browser/adapters has its own server and dependency cache.
  optimizeDeps: { entries: ['browser/index.html'] },
  resolve: {
    alias: {
      react: path.join(reactFixtureRoot, 'react'),
      'react-dom': path.join(reactFixtureRoot, 'react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
});
