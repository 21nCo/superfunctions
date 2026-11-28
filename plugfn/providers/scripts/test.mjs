#!/usr/bin/env node
// `npm test` for @plugfn/providers: the Node suite, then the workerd lane.
//
// Arguments after `--` go to the Node suite. When they hold a file filter (a
// positional argument that is not the value of an option), only the Node
// suite runs, because the filter names Node test files (the plugfn gates pass
// `-- --run <patterns>`); run the workerd lane on its own with
// `npm run test:workerd`. Option-only arguments, such as `--run`,
// `--maxWorkers=4` or `--reporter verbose`, go to both runs.
import { spawnSync } from 'node:child_process';

// Vitest options that take a value, which may follow as the next argument.
const VALUE_OPTIONS = new Set([
  '--maxWorkers', '--minWorkers', '--reporter', '--outputFile', '--config', '-c', '--project', '--root', '-r', '--dir',
  '--testNamePattern', '-t', '--pool', '--environment', '--shard', '--exclude', '--bail', '--retry', '--testTimeout',
  '--hookTimeout', '--teardownTimeout', '--sequence.seed', '--mode', '--coverage.provider', '--coverage.reporter',
  '--coverage.reportsDirectory',
]);

const args = process.argv.slice(2);

function hasFileFilter(list) {
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && VALUE_OPTIONS.has(arg) && i + 1 < list.length && !list[i + 1].startsWith('-')) i++;
      continue;
    }
    return true;
  }
  return false;
}

const filtered = hasFileFilter(args);
const shell = process.platform === 'win32';

function vitest(extra) {
  const result = spawnSync('vitest', ['run', ...extra], { stdio: 'inherit', shell });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

let status = vitest(args);
if (status === 0 && !filtered) status = vitest(['--config', 'vitest.workerd.config.ts', ...args]);
process.exit(status);
