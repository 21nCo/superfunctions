import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-secret-leak',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'node test/fixtures/vite-secret-leak/server.mjs --port 4179',
      cwd: '.',
      url: 'http://127.0.0.1:4179',
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
    },
  },
});
