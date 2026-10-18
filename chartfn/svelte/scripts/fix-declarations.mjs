import { readFileSync, writeFileSync } from 'node:fs';
// Node16/NodeNext resolve the JS-shaped specifier to Chart.svelte.d.ts.
// Only declarations change; Svelte bundlers still consume the .svelte source.
const path = new URL('../dist/index.d.ts', import.meta.url);
const source = readFileSync(path, 'utf8');
if (!source.includes('./Chart.svelte')) throw new Error('Unexpected Svelte declaration barrel');
writeFileSync(path, source.replace('"./Chart.svelte"', '"./Chart.svelte.js"'));
