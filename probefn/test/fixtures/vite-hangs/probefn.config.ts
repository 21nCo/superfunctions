import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-hangs',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'node test/fixtures/vite-hangs/server.mjs',
      cwd: '.',
      url: 'http://127.0.0.1:4174',
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
      timeoutMs: 300,
    },
  },
});
