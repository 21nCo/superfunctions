import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-regression',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'node test/fixtures/vite-regression/server.mjs --port 4210',
      cwd: '.',
      url: 'http://127.0.0.1:4210',
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
    },
  },
});
