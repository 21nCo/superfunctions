#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const docsWorkspaceRoot = process.cwd();
const repoRoot = join(docsWorkspaceRoot, '..');
const docsContentRoot = join(docsWorkspaceRoot, 'content', 'docs');
const packagesRoot = join(repoRoot, 'packages');

const packageCatalogModule = await import(pathToFileURL(join(docsWorkspaceRoot, 'lib', 'package-catalog.ts')).href);

const {
  bannedPlaceholderPhrases,
  categoryOverviewContracts,
  getExpectedPackageDocPath,
  packageCatalog,
  startHerePageContracts,
} = packageCatalogModule;

const TS_FENCE_LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'javascript']);
const INSTALL_FENCE_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);
const PYTHON_FENCE_LANGUAGES = new Set(['py', 'python']);
const MONOREPO_IMPORT_PATTERN =
  /(^@\/)|(^~\/)|(^\.{1,2}\/.*(?:packages|docs|authfn|cachefn|drawfn|plugfn|searchfn|secfn|testfn|botfn|hostfn|uifn|watchfn|billfn|browsefn|chartfn|datafn|docsfn|filefn|flowfn|iconfn|logfn|sendfn|21n)\/)|(^\/Users\/)|(^\/workspaces\/)/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(absolutePath));
    } else if (entry.isFile() && absolutePath.endsWith('.mdx')) {
      out.push(absolutePath);
    }
  }
  return out;
}

function toRepoPath(absolutePath) {
  return relative(repoRoot, absolutePath).replace(/\\/g, '/');
}

function discoverKnownTsPackages() {
  const known = new Set();
  for (const entry of readdirSync(packagesRoot).sort()) {
    const packageJsonPath = join(packagesRoot, entry, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (pkg.name) known.add(pkg.name);
  }
  return known;
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function stripCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, ' ');
}

function countProseWords(text) {
  const withoutFrontmatter = stripFrontmatter(text);
  const withoutCode = stripCodeFences(withoutFrontmatter);
  const withoutImports = withoutCode
    .replace(/^import\s.+$/gm, ' ')
    .replace(/^export\s.+$/gm, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`[^`]+`/g, ' ')
    .replace(/[{}_*|>-]/g, ' ');
  const matches = withoutImports.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g);
  return matches ? matches.length : 0;
}

function extractHeadings(text) {
  return new Set(
    [...stripFrontmatter(text).matchAll(/^##\s+(.+)$/gm)].map((match) => `## ${match[1].trim()}`),
  );
}

function extractCodeFences(text) {
  return [...text.matchAll(/```([A-Za-z0-9_-]+)?\n([\s\S]*?)```/g)].map((match) => ({
    language: (match[1] ?? '').trim().toLowerCase(),
    code: match[2],
  }));
}

function extractImportSpecifiers(code) {
  const specifiers = [];
  for (const match of code.matchAll(/from\s+["']([^"']+)["']/g)) specifiers.push(match[1]);
  for (const match of code.matchAll(/import\s+["']([^"']+)["']/g)) specifiers.push(match[1]);
  return specifiers;
}

function buildSlugIndex(files) {
  const index = new Map();
  for (const file of files) {
    const repoPath = toRepoPath(file);
    const fileName = repoPath.split('/').pop();
    if (!fileName || fileName === 'index.mdx') continue;
    const slug = fileName.replace(/\.mdx$/, '');
    const existing = index.get(slug) ?? [];
    existing.push(repoPath);
    existing.sort();
    index.set(slug, existing);
  }
  return index;
}

function actualCategoryFromPath(repoPath) {
  const relativePath = repoPath.replace(/^docs\/content\/docs\//, '');
  const [firstSegment] = relativePath.split('/');
  return firstSegment.endsWith('.mdx') ? 'root' : firstSegment;
}

function legacyCandidatePriority(repoPath) {
  if (repoPath.startsWith('docs/content/docs/shared/')) return 0;
  if (repoPath.startsWith('docs/content/docs/authentication/')) return 1;
  if (repoPath.startsWith('docs/content/docs/http/')) return 1;
  if (repoPath.startsWith('docs/content/docs/middleware-runtime/')) return 1;
  if (repoPath.startsWith('docs/content/docs/data-storage/')) return 1;
  if (repoPath.startsWith('docs/content/docs/python/')) return 1;
  if (repoPath.startsWith('docs/content/docs/tooling/')) return 1;
  return 2;
}

function selectBestLegacyCandidate(paths) {
  return [...paths].sort((left, right) => {
    const priorityDelta = legacyCandidatePriority(left) - legacyCandidatePriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return left.localeCompare(right);
  })[0] ?? null;
}

function analyzePage(contract, repoPath, text, result, knownTsPackages) {
  const headings = extractHeadings(text);
  const missingHeadings = contract.requiredSections.filter((heading) => !headings.has(heading));
  if (missingHeadings.length > 0) {
    result.missingSections.push({ path: repoPath, headings: missingHeadings });
  }

  const proseWords = countProseWords(text);
  if (proseWords < contract.minWords) {
    result.thinPages.push({ path: repoPath, proseWords, minWords: contract.minWords });
  }

  const lowered = text.toLowerCase();
  for (const phrase of bannedPlaceholderPhrases) {
    if (lowered.includes(phrase.toLowerCase())) {
      result.placeholderHits.push({ path: repoPath, phrase });
    }
  }

  if (contract.kind !== 'package') return;

  const fences = extractCodeFences(text);
  const installFenceCount = fences.filter((fence) => INSTALL_FENCE_LANGUAGES.has(fence.language)).length;
  const tsFenceCount = fences.filter((fence) => TS_FENCE_LANGUAGES.has(fence.language)).length;
  const pythonFenceCount = fences.filter((fence) => PYTHON_FENCE_LANGUAGES.has(fence.language)).length;

  if (installFenceCount < 1) {
    result.invalidExamples.push({ path: repoPath, reason: 'missing install code fence' });
  }

  if (contract.language === 'typescript' && tsFenceCount < 2) {
    result.invalidExamples.push({ path: repoPath, reason: 'expected at least two TypeScript or JavaScript example fences' });
  }

  if (contract.language === 'python' && pythonFenceCount < 2) {
    result.invalidExamples.push({ path: repoPath, reason: 'expected at least two Python example fences' });
  }

  for (const fence of fences) {
    for (const specifier of extractImportSpecifiers(fence.code)) {
      if (MONOREPO_IMPORT_PATTERN.test(specifier) || specifier.includes('/packages/')) {
        result.invalidExamples.push({ path: repoPath, reason: `monorepo-only import: ${specifier}` });
        continue;
      }

      if (specifier.startsWith('@superfunctions/') && !knownTsPackages.has(specifier)) {
        result.invalidExamples.push({ path: repoPath, reason: `nonexistent package import: ${specifier}` });
      }
    }
  }
}

const files = walk(docsContentRoot);
const existingFiles = new Set(files.map((file) => toRepoPath(file)));
const slugIndex = buildSlugIndex(files);
const knownTsPackages = discoverKnownTsPackages();
const result = {
  ok: true,
  missingPages: [],
  missingSections: [],
  wrongCategory: [],
  thinPages: [],
  placeholderHits: [],
  invalidExamples: [],
};

const analyzedPaths = new Set();

for (const contract of startHerePageContracts.map((entry) => ({ ...entry, kind: 'start' }))) {
  if (!existingFiles.has(contract.path)) {
    result.missingPages.push(contract.path);
    continue;
  }

  analyzedPaths.add(contract.path);
  analyzePage(contract, contract.path, readFileSync(join(repoRoot, contract.path), 'utf8'), result, knownTsPackages);
}

for (const contract of categoryOverviewContracts.map((entry) => ({ ...entry, kind: 'category' }))) {
  if (!existingFiles.has(contract.path)) {
    result.missingPages.push(contract.path);
    continue;
  }

  analyzedPaths.add(contract.path);
  analyzePage(contract, contract.path, readFileSync(join(repoRoot, contract.path), 'utf8'), result, knownTsPackages);
}

for (const entry of packageCatalog) {
  const expectedPath = getExpectedPackageDocPath(entry);
  const legacyCandidates = (slugIndex.get(entry.slug) ?? []).filter((repoPath) => repoPath !== expectedPath);
  const bestLegacyCandidate = selectBestLegacyCandidate(legacyCandidates);
  const existingPath = existingFiles.has(expectedPath) ? expectedPath : bestLegacyCandidate;

  if (!existingFiles.has(expectedPath)) {
    result.missingPages.push(expectedPath);
  }

  if (bestLegacyCandidate) {
    result.wrongCategory.push({
      slug: entry.slug,
      expected: entry.category,
      actual: actualCategoryFromPath(bestLegacyCandidate),
    });
  }

  if (!existingPath || analyzedPaths.has(existingPath)) continue;

  analyzedPaths.add(existingPath);
  analyzePage(
    {
      path: expectedPath,
      title: entry.title,
      requiredSections: entry.requiredSections,
      minWords: entry.language === 'python' ? 300 : 350,
      kind: 'package',
      language: entry.language,
    },
    existingPath,
    readFileSync(join(repoRoot, existingPath), 'utf8'),
    result,
    knownTsPackages,
  );
}

const ok =
  result.missingPages.length === 0 &&
  result.missingSections.length === 0 &&
  result.wrongCategory.length === 0 &&
  result.thinPages.length === 0 &&
  result.placeholderHits.length === 0 &&
  result.invalidExamples.length === 0;

if (ok) {
  console.log(JSON.stringify({ ...result, ok: true }));
  process.exit(0);
}

console.error(JSON.stringify({ ...result, ok: false, error: { code: 'DOCS_CONTENT_INVALID' } }));
process.exit(1);
