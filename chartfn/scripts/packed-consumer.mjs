import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = mkdtempSync(join(tmpdir(), 'chartfn-consumer-'));
const run = (cmd, args, cwd = consumer) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const tarballs = ['.', 'react', 'svelte'].map(part => {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], resolve(root, part)));
  return join(consumer, packed[0].filename);
});
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit', ...tarballs, 'react@18.3.1', 'react-dom@18.3.1', 'svelte@5']);
run('npm', ['install', '--save-dev', '--ignore-scripts', '--no-fund', '--no-audit', 'typescript@5.9.3', '@types/react@18', '@types/react-dom@18']);
writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { Chart as ReactChart } from '@chartfn/react';
import { Chart as SvelteChart } from '@chartfn/svelte';
import { render } from 'svelte/server';
import { chartFn } from 'chartfn';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
assert.equal(typeof require('chartfn').chartFn, 'function');
assert.equal(typeof require('@chartfn/react').Chart, 'function');
const spec = { type: 'bar', data: { series: [{ values: [1, 2] }] } };
const api = chartFn({ defaultAdapter: 'ssr', adapters: { ssr: { name: 'ssr', mount() { throw Error('SSR mounted chart'); } } } });
assert.match(renderToString(React.createElement(ReactChart, { spec, api })), /<div/);
assert.match(render(SvelteChart, { props: { spec, api } }).body, /<div/);
console.log('Packed ESM/CJS imports and React/Svelte SSR passed');
`);
console.log(run(process.execPath, ['smoke.mjs']));
const fixture = `import { chartFn, type ChartSpec } from 'chartfn';
import { Chart } from '@chartfn/react';
const spec: ChartSpec = { type: 'bar', data: { series: [{ values: [1] }] } };
const api = chartFn({ defaultAdapter: 'custom' });
void [spec, api, Chart];
`;
writeFileSync(join(consumer, 'consumer.mts'), fixture + "import { Chart as SvelteChart } from '@chartfn/svelte'; void SvelteChart;\n");
writeFileSync(join(consumer, 'consumer.cts'), fixture);
for (const mode of ['Node16', 'NodeNext']) {
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2021', '--module', mode, '--moduleResolution', mode, '--esModuleInterop', 'consumer.mts', 'consumer.cts']);
}
console.log(`Packed declaration checks passed. Consumer retained at ${consumer}`);
