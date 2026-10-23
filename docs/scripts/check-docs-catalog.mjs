#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const docsRoot = process.cwd();
const repoRoot = join(docsRoot, '..');
const packagesRoot = join(repoRoot, 'packages');
const agentsPath = join(repoRoot, 'AGENTS.md');

const packageCatalogModule = await import(pathToFileURL(join(docsRoot, 'lib', 'package-catalog.ts')).href);
const ecosystemCatalogModule = await import(pathToFileURL(join(docsRoot, 'lib', 'ecosystem-catalog.ts')).href);

const { docsCategories, forbiddenTopLevelBuckets, packageCatalog } = packageCatalogModule;
const { ecosystemCatalog } = ecosystemCatalogModule;

const REQUIRED_TOP_LEVEL_SECTIONS = [
  'Start Here',
  'Authentication & OAuth',
  'HTTP & Framework Adapters',
  'Middleware & Runtime',
  'Data & Storage',
  'Python Integrations',
  'Tooling',
];

const REQUIRED_PACKAGE_CATEGORIES = [
  'authentication',
  'http',
  'middleware-runtime',
  'data-storage',
  'python',
  'tooling',
];

function parsePyprojectValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match ? match[1] : null;
}

function discoverSharedPackages() {
  const discovered = [];
  for (const entry of readdirSync(packagesRoot).sort()) {
    const dir = join(packagesRoot, entry);
    const packageJsonPath = join(dir, 'package.json');
    const pyprojectPath = join(dir, 'pyproject.toml');

    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      discovered.push({ slug: entry, packageName: pkg.name ?? null, language: 'typescript' });
      continue;
    }

    if (existsSync(pyprojectPath)) {
      const pyproject = readFileSync(pyprojectPath, 'utf8');
      discovered.push({
        slug: entry,
        packageName: parsePyprojectValue(pyproject, 'name'),
        language: 'python',
      });
    }
  }

  return discovered;
}

function extractExpectedFunctions() {
  const text = readFileSync(agentsPath, 'utf8');
  const sectionMatch = text.match(/### Core Functions \(Top-Level Directories\)([\s\S]*?)### Shared Packages/);
  const section = sectionMatch ? sectionMatch[1] : '';
  return [...section.matchAll(/- \*\*`([^`]+)\/`\*\*/g)].map((match) => match[1]);
}

function findDuplicates(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function findDuplicateOrders(entries) {
  const duplicates = [];
  for (const category of REQUIRED_PACKAGE_CATEGORIES) {
    const byOrder = new Map();
    for (const entry of entries.filter((item) => item.category === category)) {
      const existing = byOrder.get(entry.order) ?? [];
      existing.push(entry.slug);
      byOrder.set(entry.order, existing);
    }

    for (const [order, slugs] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
      if (slugs.length > 1) {
        duplicates.push({ category, order, slugs: [...slugs].sort() });
      }
    }
  }

  return duplicates;
}

function isCatalogSorted(entries) {
  const categoryIndex = new Map(REQUIRED_PACKAGE_CATEGORIES.map((category, index) => [category, index]));
  const sorted = [...entries].sort((left, right) => {
    const categoryDelta = (categoryIndex.get(left.category) ?? 999) - (categoryIndex.get(right.category) ?? 999);
    if (categoryDelta !== 0) return categoryDelta;
    const orderDelta = left.order - right.order;
    if (orderDelta !== 0) return orderDelta;
    return left.slug.localeCompare(right.slug);
  });

  return entries.every((entry, index) => entry.slug === sorted[index]?.slug);
}

const discoveredPackages = discoverSharedPackages();
const discoveredBySlug = new Map(discoveredPackages.map((entry) => [entry.slug, entry]));
const catalogBySlug = new Map(packageCatalog.map((entry) => [entry.slug, entry]));
const allowedCategories = new Set(REQUIRED_PACKAGE_CATEGORIES);
const requiredFunctions = extractExpectedFunctions();
const actualTopLevelSections = docsCategories.map((category) => category.title);

const missingPackages = discoveredPackages
  .filter((entry) => !catalogBySlug.has(entry.slug))
  .map((entry) => entry.slug);

const extraPackages = packageCatalog
  .filter((entry) => !discoveredBySlug.has(entry.slug))
  .map((entry) => entry.slug);

const duplicateSlugs = findDuplicates(packageCatalog.map((entry) => entry.slug));
const duplicatePackageNames = findDuplicates(packageCatalog.map((entry) => entry.packageName));
const missingCategories = REQUIRED_PACKAGE_CATEGORIES.filter(
  (category) => !packageCatalog.some((entry) => entry.category === category),
);
const invalidCategories = packageCatalog
  .filter((entry) => !allowedCategories.has(entry.category))
  .map((entry) => ({ slug: entry.slug, category: entry.category }));
const duplicateOrders = findDuplicateOrders(packageCatalog);
const invalidOrder = isCatalogSorted(packageCatalog) ? [] : ['packageCatalog'];
const invalidPackageNames = discoveredPackages
  .filter((entry) => catalogBySlug.has(entry.slug) && catalogBySlug.get(entry.slug).packageName !== entry.packageName)
  .map((entry) => ({
    slug: entry.slug,
    expected: entry.packageName,
    actual: catalogBySlug.get(entry.slug).packageName,
  }));
const invalidLanguages = discoveredPackages
  .filter((entry) => catalogBySlug.has(entry.slug) && catalogBySlug.get(entry.slug).language !== entry.language)
  .map((entry) => ({
    slug: entry.slug,
    expected: entry.language,
    actual: catalogBySlug.get(entry.slug).language,
  }));
const invalidRelatedPackages = packageCatalog
  .flatMap((entry) =>
    entry.relatedPackages
      .filter((slug) => !catalogBySlug.has(slug))
      .map((slug) => ({ slug: entry.slug, relatedPackage: slug })),
  );

const missingTopLevelSections = REQUIRED_TOP_LEVEL_SECTIONS.filter(
  (title) => !actualTopLevelSections.includes(title),
);
const unexpectedTopLevelSections = actualTopLevelSections.filter(
  (title) => !REQUIRED_TOP_LEVEL_SECTIONS.includes(title),
);
const forbiddenBucketsPresent = actualTopLevelSections.filter((title) => forbiddenTopLevelBuckets.includes(title));
const ecosystemSlugs = ecosystemCatalog.map((entry) => entry.slug);
const duplicateEcosystemSlugs = findDuplicates(ecosystemSlugs);
const missingEcosystemEntries = requiredFunctions.filter((slug) => !ecosystemSlugs.includes(slug));
const extraEcosystemEntries = ecosystemSlugs.filter((slug) => !requiredFunctions.includes(slug));
const invalidEcosystemEntries = ecosystemCatalog
  .filter((entry) => !entry.summary || !entry.href || !entry.hrefKind)
  .map((entry) => entry.slug);
const ecosystemOrderMismatch = ecosystemSlugs.length === requiredFunctions.length &&
  ecosystemSlugs.every((slug, index) => slug === requiredFunctions[index])
  ? []
  : ['ecosystemCatalog'];

const ok =
  missingTopLevelSections.length === 0 &&
  unexpectedTopLevelSections.length === 0 &&
  forbiddenBucketsPresent.length === 0 &&
  missingPackages.length === 0 &&
  extraPackages.length === 0 &&
  duplicateSlugs.length === 0 &&
  duplicatePackageNames.length === 0 &&
  missingCategories.length === 0 &&
  invalidCategories.length === 0 &&
  duplicateOrders.length === 0 &&
  invalidOrder.length === 0 &&
  invalidPackageNames.length === 0 &&
  invalidLanguages.length === 0 &&
  invalidRelatedPackages.length === 0 &&
  duplicateEcosystemSlugs.length === 0 &&
  missingEcosystemEntries.length === 0 &&
  extraEcosystemEntries.length === 0 &&
  invalidEcosystemEntries.length === 0 &&
  ecosystemOrderMismatch.length === 0;

const payload = {
  ok,
  topLevelSections: actualTopLevelSections,
  missingTopLevelSections,
  unexpectedTopLevelSections,
  forbiddenBucketsPresent,
  missingPackages,
  extraPackages,
  duplicateSlugs,
  duplicatePackageNames,
  missingCategories,
  invalidCategories,
  duplicateOrders,
  invalidOrder,
  invalidPackageNames,
  invalidLanguages,
  invalidRelatedPackages,
  missingEcosystemEntries,
  extraEcosystemEntries,
  duplicateEcosystemSlugs,
  invalidEcosystemEntries,
  ecosystemOrderMismatch,
};

if (ok) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

let errorCode = 'DOCS_CATALOG_INVALID';
if (
  missingTopLevelSections.length > 0 ||
  unexpectedTopLevelSections.length > 0 ||
  forbiddenBucketsPresent.length > 0
) {
  errorCode = 'DOCS_NAV_INVALID';
} else if (missingEcosystemEntries.length > 0 || duplicateEcosystemSlugs.length > 0) {
  errorCode = 'DOCS_ECOSYSTEM_INCOMPLETE';
}

console.error(JSON.stringify({ ...payload, error: { code: errorCode } }));
process.exit(1);
