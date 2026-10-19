import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { instrumentation: 'src/instrumentation.ts', index: 'src/index.ts', 'adapters/memory': 'src/adapters/memory.ts', 'adapters/redis': 'src/adapters/redis.ts', 'adapters/postgres': 'src/adapters/postgres/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
