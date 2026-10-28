#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const repoRoot = process.cwd();
const graph = JSON.parse(readFileSync('uifn/package-graph.json', 'utf8'));
// Vitest prints one "Tests  <n> passed (<n>)" summary per run; Solid runs two (DOM and SSR).
const adapterVitestRuns = { '@uifn/react': 1, '@uifn/svelte': 1, '@uifn/solid': 2 };
const adapters = Object.keys(adapterVitestRuns);
const adapterTestCommand = (name) => ['npm', '--workspace', name, 'run', 'test'].join(' ');
const adapterByTestCommand = new Map(adapters.map((name) => [adapterTestCommand(name), name]));

function vitestTestCounts(stdout) {
  const plain = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  return [...plain.matchAll(/^\s*Tests\s+(\d.*?)\s*$/gm)].map((match) => match[1]);
}

const checks = [
  [process.execPath, ['scripts/verify-uifn-package-graph.mjs', '--stable-only']],
  [process.execPath, ['scripts/verify-uifn-clean.mjs']],
  ['npm', ['run', 'verify:uifn-governance']],
  [process.execPath, ['scripts/verify-uifn-catalog.mjs']],
  ['npm', ['--workspace', '@uifn/core', 'run', 'typecheck']],
  ['npm', ['--workspace', '@uifn/core', 'run', 'test']],
  ['npm', ['--workspace', '@uifn/core', 'run', 'build']],
  ['npm', ['--workspace', '@uifn/dom', 'run', 'typecheck']],
  ['npm', ['--workspace', '@uifn/dom', 'run', 'test']],
  ['npm', ['--workspace', '@uifn/dom', 'run', 'build']],
  [process.execPath, ['--test', 'scripts/verify-uifn-dom-platform.test.mjs']],
  [process.execPath, ['scripts/verify-uifn-dom-platform.mjs']],
  ['npm', ['--workspace', '@uifn/adapter-kit', 'run', 'build']],
  ...adapters.flatMap((name) => [
    ['npm', ['--workspace', name, 'run', 'typecheck']],
    ['npm', ['--workspace', name, 'run', 'test']],
    // test:browser mounts the built adapters in browser/adapters scenarios.
    ['npm', ['--workspace', name, 'run', 'build']],
  ]),
  ['npm', ['--workspace', '@uifn/dom', 'run', 'test:browser']],
  [process.execPath, ['--test', 'scripts/verify-uifn-runtime-architecture.test.mjs']],
  [process.execPath, ['scripts/verify-uifn-runtime-architecture.mjs', '--require-dist']],
  [process.execPath, ['scripts/verify-uifn-core-node-matrix.mjs']],
  [process.execPath, ['--test', 'scripts/verify-uifn-package-graph.test.mjs', 'scripts/verify-uifn-clean.test.mjs', 'scripts/uifn-catalog-csp.test.mjs']],
  ['npm', ['--workspace', '@uifn/components', 'run', 'test']],
  ['npm', ['--workspace', '@uifn/registry', 'run', 'test:stable']],
  [process.execPath, ['scripts/verify-uifn-consumers.mjs']],
  [process.execPath, ['scripts/verify-uifn-pack.mjs']],
].map(([command, args]) => {
  const commandLine = [command, ...args].join(' ');
  const adapter = adapterByTestCommand.get(commandLine);
  // Plain output keeps the Vitest summaries parseable.
  const env = adapter ? { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } : process.env;
  const result = spawnSync(command, args, { cwd: repoRoot, env, encoding: 'utf8' });
  const testCounts = adapter ? vitestTestCounts(result.stdout) : undefined;
  return {
    command: commandLine,
    // An adapter test run without one summary per Vitest run did not prove anything.
    ok: result.status === 0 && (testCounts === undefined || testCounts.length === adapterVitestRuns[adapter]),
    status: result.status,
    ...(testCounts === undefined ? {} : { testCounts }),
    stdout: result.stdout.split('\n').slice(-28).join('\n').trim(),
    stderr: result.stderr.split('\n').slice(-28).join('\n').trim(),
  };
});

const result = {
  ok: checks.every((check) => check.ok),
  command: 'verify:uifn-stable',
  mode: process.env.UIFN_EXPERIMENTAL_ABSENT === '1' ? 'experimental-directories-absent' : 'normal',
  graphSha256: createHash('sha256').update(JSON.stringify(graph)).digest('hex'),
  stablePackages: graph.stable.map((entry) => entry.name),
  adapterTestCounts: Object.fromEntries(adapters.map((name) => [
    name,
    checks.find((check) => check.command === adapterTestCommand(name))?.testCounts ?? [],
  ])),
  checks,
};
console[result.ok ? 'log' : 'error'](JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
