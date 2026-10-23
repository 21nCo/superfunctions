import { defineConfig } from '../../../packages/contracts/src/index.js';

export default defineConfig({
  schemaVersion: '1.0',
  projectName: 'absolute-artifact-root',
  artifactRoot: '/tmp/probefn-artifacts' as never,
  devServers: {
    web: {
      mode: 'attach',
      name: 'web',
      url: 'http://127.0.0.1:4175',
    },
  },
});
