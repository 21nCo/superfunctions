#!/usr/bin/env node
// `npm test` for @plugfn/providers: the Node suite, then the workerd lane.
//
// Arguments after `--` go to the Node suite. When they hold a file filter,
// only the Node suite runs, because the filter names Node test files (the
// plugfn gates pass `-- --run <patterns>`); run the workerd lane on its own
// with `npm run test:workerd`. Option-only arguments, such as `--run`,
// `--maxWorkers=4` or `--maxConcurrency 2`, go to both runs. Vitest's own
// argument parser decides which arguments are filters.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseCLI } from 'vitest/node';

const args = process.argv.slice(2);
const filtered = parseCLI(['vitest', 'run', ...args]).filter.length > 0;

// Run Vitest's own entry with this Node, without a shell, so arguments reach it unchanged on every platform.
const require = createRequire(import.meta.url);
const vitestPackage = require.resolve('vitest/package.json');
const vitestBin = join(dirname(vitestPackage), require(vitestPackage).bin.vitest);

function vitest(extra) {
  const result = spawnSync(process.execPath, [vitestBin, 'run', ...extra], { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

let status = vitest(args);
if (status === 0 && !filtered) status = vitest(['--config', 'vitest.workerd.config.ts', ...args]);
process.exit(status);
