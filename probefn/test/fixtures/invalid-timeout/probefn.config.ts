import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'invalid-timeout',
  devServers: {
    web: {
      mode: 'spawn',
      name: 'web',
      command: 'pnpm vite --port 4176',
      cwd: '.',
      url: 'http://127.0.0.1:4176',
      timeoutMs: 0 as never,
    },
  },
});
