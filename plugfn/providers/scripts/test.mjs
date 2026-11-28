#!/usr/bin/env node
// `npm test` for @plugfn/providers: the Node suite, then the workerd lane.
//
// Arguments after `--` go to the Node suite. When they hold a file filter (any
// argument that does not start with `-`), only the Node suite runs, because the
// filter names Node test files (the plugfn gates pass `-- --run <patterns>`);
// run the workerd lane on its own with `npm run test:workerd`. Flag-only
// arguments, such as `--run` or `--maxWorkers=4`, go to both runs.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const filtered = args.some((arg) => !arg.startsWith('-'));
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
