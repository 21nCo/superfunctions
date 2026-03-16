#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const docsRoot = join(root, 'content', 'docs');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && p.endsWith('.mdx')) out.push(p);
  }
  return out;
}

const files = walk(docsRoot);
const routes = new Set();
for (const file of files) {
  const rel = relative(docsRoot, file).replace(/\\/g, '/');
  if (rel.endsWith('/index.mdx')) {
    const base = rel.slice(0, -'/index.mdx'.length);
    routes.add(base ? `/docs/${base}` : '/docs');
  } else {
    routes.add(`/docs/${rel.replace(/\.mdx$/, '')}`);
  }
}

const broken = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const link of links) {
    if (link.startsWith('http://') || link.startsWith('https://') || link.startsWith('mailto:') || link.startsWith('#')) {
      continue;
    }
    const clean = link.split('#')[0].split('?')[0];
    if (!clean) continue;
    if (clean.startsWith('/docs')) {
      if (!routes.has(clean)) broken.push({ file, link });
      continue;
    }
    if (clean.startsWith('/')) continue;
  }
}

if (broken.length === 0) {
  console.log(JSON.stringify({ ok: true, broken: [] }));
  process.exit(0);
}

console.error(JSON.stringify({ ok: false, error: { code: 'DOCS_LINK_INVALID' }, broken }));
process.exit(1);
