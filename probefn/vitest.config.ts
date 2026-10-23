import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Source integration tests share one class identity; installed consumers use dist exports.
const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
export const sourceAliases = [
  { find: /^@probefn\/contracts\/(.+)$/, replacement: source('./packages/contracts/src/$1.ts') },
  { find: '@probefn/cli', replacement: source('./apps/cli/src/index.ts') },
  ...['analyzers', 'browser-runner', 'contracts', 'core', 'dev-server', 'mcp-server', 'session-reporter', 'storage', 'visual-baselines'].map(name => ({ find: `@probefn/${name}`, replacement: source(`./packages/${name}/src/index.ts`) })),
];

export default defineConfig({ resolve: { alias: sourceAliases }, test: { fileParallelism: false, include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'] } });
