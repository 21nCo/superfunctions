import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-token-drift',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'node test/fixtures/vite-token-drift/server.mjs --port 4192',
      cwd: '.',
      url: 'http://127.0.0.1:4192',
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
    },
  },
});
