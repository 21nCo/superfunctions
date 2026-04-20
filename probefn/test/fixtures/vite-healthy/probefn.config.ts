import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-healthy',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'node test/fixtures/vite-healthy/server.mjs --port 4173',
      cwd: '.',
      url: 'http://127.0.0.1:4173',
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
    },
  },
});
