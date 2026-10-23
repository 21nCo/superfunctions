#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const repoRoot = join(root, '..');
const packagesDir = join(repoRoot, 'packages');
const sharedDir = join(root, 'content', 'docs', 'shared');
const sharedMetaPath = join(sharedDir, 'meta.json');
const architectureDir = join(root, 'content', 'docs', 'architecture');
const architectureMetaPath = join(architectureDir, 'meta.json');
const migrationsDir = join(root, 'content', 'docs', 'migrations');
const migrationsMetaPath = join(migrationsDir, 'meta.json');

function packageNameFromPyproject(pyprojectPath) {
  const text = readFileSync(pyprojectPath, 'utf8');
  const match = text.match(/^name\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

const expectedSlugs = [];
for (const dir of readdirSync(packagesDir)) {
  const pkgJson = join(packagesDir, dir, 'package.json');
  if (existsSync(pkgJson)) expectedSlugs.push(dir);
}
for (const dir of readdirSync(packagesDir).filter((d) => d.startsWith('python-'))) {
  const pyproject = join(packagesDir, dir, 'pyproject.toml');
  if (existsSync(pyproject) && packageNameFromPyproject(pyproject)) expectedSlugs.push(dir);
}
expectedSlugs.sort();

const missing = expectedSlugs.filter((slug) => !existsSync(join(sharedDir, `${slug}.mdx`)));

const sharedMeta = JSON.parse(readFileSync(sharedMetaPath, 'utf8'));
const sharedPages = new Set(sharedMeta.pages ?? []);
const missingInNav = expectedSlugs.filter((slug) => !sharedPages.has(slug));

const requiredOAuth = ['oauth-core', 'oauth-http', 'oauth-storage', 'oauth-providers', 'oauth-testing', 'oauth-flow'];
const missingOAuth = requiredOAuth.filter((slug) => !existsSync(join(sharedDir, `${slug}.mdx`)));

const requiredArchitecturePages = [
  'oauth-flow-architecture',
  'webhooks-architecture',
  'envelope-errors',
  'queue-rate-limit',
  'http-db-integration',
];
const architectureMeta = JSON.parse(readFileSync(architectureMetaPath, 'utf8'));
const architecturePages = new Set(architectureMeta.pages ?? []);
const missingArchitectureFiles = requiredArchitecturePages.filter((page) => !existsSync(join(architectureDir, `${page}.mdx`)));
const missingArchitectureInNav = requiredArchitecturePages.filter((page) => !architecturePages.has(page));

const requiredMigrations = ['oauth-flow', 'reuse-extraction'];
const migrationsMeta = JSON.parse(readFileSync(migrationsMetaPath, 'utf8'));
const migrationPages = new Set(migrationsMeta.pages ?? []);
const missingMigrationFiles = requiredMigrations.filter((page) => !existsSync(join(migrationsDir, `${page}.mdx`)));
const missingMigrationInNav = requiredMigrations.filter((page) => !migrationPages.has(page));

const ok =
  missing.length === 0 &&
  missingInNav.length === 0 &&
  missingOAuth.length === 0 &&
  missingArchitectureFiles.length === 0 &&
  missingArchitectureInNav.length === 0 &&
  missingMigrationFiles.length === 0 &&
  missingMigrationInNav.length === 0;

const payload = {
  ok,
  undocumented: missing,
  missingInNav,
  missingOAuth,
  missingArchitectureFiles,
  missingArchitectureInNav,
  missingMigrationFiles,
  missingMigrationInNav,
};

if (ok) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

const code = missing.length > 0 ? 'SHARED_PACKAGE_PAGE_MISSING' : 'DOCS_COVERAGE_INCOMPLETE';
console.error(JSON.stringify({ ...payload, error: { code } }));
process.exit(1);
