#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const repoRoot = join(root, '..');
const docsRoot = join(root, 'content', 'docs');
const packagesDir = join(repoRoot, 'packages');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && p.endsWith('.mdx')) out.push(p);
  }
  return out;
}

const knownTsPackages = new Set();
for (const d of readdirSync(packagesDir)) {
  const pkgJson = join(packagesDir, d, 'package.json');
  if (!existsSync(pkgJson)) continue;
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  if (pkg.name) knownTsPackages.add(pkg.name);
}

const files = walk(docsRoot);
const invalidImports = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const fences = [...text.matchAll(/```(?:ts|tsx|js|jsx|mjs|cjs|typescript)[\s\S]*?```/g)];
  for (const fence of fences) {
    const code = fence[0];
    const importMatches = code.matchAll(/from\s+["']([^"']+)["']/g);
    for (const m of importMatches) {
      const spec = m[1];
      if (!spec.startsWith('@superfunctions/')) continue;
      if (!knownTsPackages.has(spec)) {
        invalidImports.push({ file, spec });
      }
    }
  }
}

if (invalidImports.length === 0) {
  console.log(JSON.stringify({ ok: true, invalidImports: [] }));
  process.exit(0);
}

console.error(
  JSON.stringify({
    ok: false,
    error: { code: 'DOCS_SNIPPET_INVALID' },
    invalidImports,
  }),
);
process.exit(1);
