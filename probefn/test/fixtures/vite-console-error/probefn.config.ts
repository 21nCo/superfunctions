import { defineConfig } from '../../../packages/contracts/src/index.js';

const port = Number(process.env.PROBEFN_VITE_CONSOLE_ERROR_PORT ?? '4176');

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'vite-console-error',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: `node test/fixtures/vite-console-error/server.mjs --port ${port}`,
      cwd: '.',
      url: `http://127.0.0.1:${port}`,
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
    },
  },
});
