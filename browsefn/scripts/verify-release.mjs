#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const dryRun = process.argv.includes('--dry-run');

const steps = [
  {
    label: 'TypeScript build',
    command: 'npm',
    args: ['--prefix', 'browsefn/typescript', 'run', 'build'],
  },
  {
    label: 'TypeScript typecheck',
    command: 'npm',
    args: ['--prefix', 'browsefn/typescript', 'run', 'typecheck'],
  },
  {
    label: 'TypeScript tests',
    command: 'npm',
    args: ['--prefix', 'browsefn/typescript', 'run', 'test', '--', '--run'],
  },
  {
    label: 'Python compileall',
    command: 'python3',
    args: ['-m', 'compileall', 'browsefn/python/browsefn', 'browsefn/python/tests'],
  },
  {
    label: 'Python tests',
    command: 'python3',
    args: ['-m', 'pytest', 'browsefn/python/tests', '-q'],
  },
  {
    label: 'Duplication gate',
    command: process.execPath,
    args: ['browsefn/scripts/check-duplication.mjs'],
  },
];

const commandList = steps.map(
  (step) => `${step.command} ${step.args.join(' ')}`
);

if (dryRun) {
  console.log(
    JSON.stringify({
      ok: true,
      dryRun: true,
      readyForNucleus: false,
      commands: commandList,
      releaseGate: 'browsefn/README.md',
    })
  );
  process.exit(0);
}

for (const [index, step] of steps.entries()) {
  console.log(`==> [${index + 1}/${steps.length}] ${step.label}`);
  try {
    execFileSync(step.command, step.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        readyForNucleus: false,
        failedStep: step.label,
        failedCommand: `${step.command} ${step.args.join(' ')}`,
      })
    );
    process.exit(error.status || 1);
  }
}

console.log(
  JSON.stringify({
    ok: true,
    readyForNucleus: true,
    commands: commandList,
    releaseGate: 'browsefn/README.md',
    summary: 'BrowseFn release gate passed and is ready for external consumption in nucleus.',
  })
);
