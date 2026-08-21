import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(root, 'src');
const allowedImplementationDependencies = new Set(['mcpfn', 'uifn']);
const forbiddenCatalogSymbols = /\b(?:KNOWN_MODULE_IDS|MODULE_CATALOG|NESTED_OWNERS|FOLDED_MODULE_IDS)\b/g;
const functionIdentifier = /\b([a-z][a-z0-9-]*fn)\b/gi;

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const findings = [];
for (const file of files(sourceRoot)) {
  if (!['.ts', '.svelte'].includes(extname(file))) continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(functionIdentifier)) {
    const identifier = match[1].toLowerCase();
    if (!allowedImplementationDependencies.has(identifier)) {
      findings.push(`${relative(root, file)}:${source.slice(0, match.index).split('\n').length}: concrete function identifier ${identifier}`);
    }
  }
  for (const match of source.matchAll(forbiddenCatalogSymbols)) {
    findings.push(`${relative(root, file)}:${source.slice(0, match.index).split('\n').length}: fixed catalog symbol ${match[0]}`);
  }
}

if (findings.length) {
  console.error('Super Console core must remain function-agnostic:\n' + findings.map((finding) => `- ${finding}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Super Console function-agnostic source guard passed.');
}
