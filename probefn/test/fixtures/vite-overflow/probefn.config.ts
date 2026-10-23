import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-overflow',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'node test/fixtures/vite-overflow/server.mjs --port 4190',
      cwd: '.',
      url: 'http://127.0.0.1:4190',
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
    },
  },
});
