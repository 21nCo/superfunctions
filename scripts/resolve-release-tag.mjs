import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { REPOS } from './owners.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = `${number}\\.${number}\\.${number}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;
const tagPattern = new RegExp(`^([a-z0-9][a-z0-9-]*)-v(${versionPattern})$`);

export const RELEASE_BASE_FILE = 'release-packages.json';
/** Optional overlay of a non-public repository (SFNS-121 D3): `next` lists its own release entries there. */
export const releaseOverlayFile = repo => `release-packages.${repo}.json`;
const OVERLAY_REPOS = REPOS.filter(repo => repo !== 'public');

export class ReleaseTargetError extends Error {
  /**
   * @param {'malformed-release-file' | 'invalid-target' | 'invalid-target-path' | 'duplicate-slug' | 'duplicate-name' | 'invalid-bare-target'} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseTargetError';
    this.code = code;
    this.details = details;
  }
}

async function readTargetFile(root, file, { optional }) {
  let source;
  try {
    source = await readFile(path.join(root, file), 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  let targets;
  try {
    targets = JSON.parse(source);
  } catch (error) {
    throw new ReleaseTargetError('malformed-release-file', `${file}: invalid JSON: ${error.message}`, { file });
  }
  if (!Array.isArray(targets)) throw new ReleaseTargetError('malformed-release-file', `Expected ${file} to contain an array`, { file });
  return targets;
}

/**
 * Release targets of a checkout: release-packages.json merged with the repository overlay
 * (release-packages.<repo>.json) when one is present. Each slug and npm name has exactly one entry across
 * both files; an overlay that repeats a base slug fails with a `duplicate-slug` ReleaseTargetError.
 */
export async function loadReleaseTargets({ root = repoRoot } = {}) {
  const files = [{ file: RELEASE_BASE_FILE, optional: false }, ...OVERLAY_REPOS.map(repo => ({ file: releaseOverlayFile(repo), optional: true }))];
  const bySlug = new Map();
  const byName = new Map();
  const merged = [];
  for (const { file, optional } of files) {
    const targets = await readTargetFile(root, file, { optional });
    if (targets === null) continue;
    for (const entry of targets) {
      if (!['slug', 'name', 'path'].every(field => typeof entry?.[field] === 'string' && entry[field] !== '')) {
        throw new ReleaseTargetError('invalid-target', `Invalid release target in ${file}: ${JSON.stringify(entry)}`, { file, entry });
      }
      const sameSlug = bySlug.get(entry.slug);
      if (sameSlug) {
        const where = sameSlug.source === file ? `more than once in ${file}` : `in both ${sameSlug.source} and ${file}`;
        throw new ReleaseTargetError('duplicate-slug', `Release slug "${entry.slug}" is listed ${where}; an overlay must not repeat a base slug`, { file, slug: entry.slug, first: sameSlug.source });
      }
      const sameName = byName.get(entry.name);
      if (sameName) {
        throw new ReleaseTargetError('duplicate-name', `Release targets "${sameName.slug}" (${sameName.source}) and "${entry.slug}" (${file}) both publish ${entry.name}`, { file, name: entry.name, first: sameName.source });
      }
      const relative = path.relative(root, path.resolve(root, entry.path));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ReleaseTargetError('invalid-target-path', `Invalid target path in ${file}: ${entry.path}`, { file, path: entry.path });
      }
      const target = { slug: entry.slug, name: entry.name, path: entry.path, source: file };
      const bare = bareLinks(file, entry);
      if (bare) target.bare = bare;
      bySlug.set(entry.slug, target);
      byName.set(entry.name, target);
      merged.push(target);
    }
  }
  for (const target of merged) if (target.bare) checkBareLinks(target, bySlug);
  return merged;
}

/**
 * A bare (front-door) release target, `"kind": "bare"`, is the product's unscoped npm package. It names the release
 * slugs of the product's core (`core`, which is its own slug when the bare package is the core itself) and CLI
 * (`cli`); at least one. scripts/assert-bare-release.mjs holds the three at one version when the bare slug is released.
 * Returns `{ core, cli }` (each a slug or null) for a bare entry, or null for any other entry.
 */
function bareLinks(file, entry) {
  const invalid = message => new ReleaseTargetError('invalid-bare-target', `Invalid bare release target ${JSON.stringify(entry.slug)} in ${file}: ${message}`, { file, slug: entry.slug });
  if (entry.kind === undefined) {
    if (entry.core !== undefined || entry.cli !== undefined) throw invalid('"core" and "cli" apply only to "kind": "bare"');
    return null;
  }
  if (entry.kind !== 'bare') throw invalid(`"kind" must be "bare", not ${JSON.stringify(entry.kind)}`);
  for (const field of ['core', 'cli']) {
    if (entry[field] !== undefined && (typeof entry[field] !== 'string' || entry[field] === '')) throw invalid(`"${field}" must be a release slug`);
  }
  if (entry.core === undefined && entry.cli === undefined) throw invalid('it needs a "core" or a "cli" release slug, or both');
  if (entry.cli === entry.slug) throw invalid('"cli" must be the slug of the scoped CLI package, not the bare package itself');
  if (entry.name.startsWith('@')) throw invalid(`a bare package has an unscoped npm name, not ${entry.name}`);
  return { core: entry.core ?? null, cli: entry.cli ?? null };
}

/** The core and CLI of a bare target are other, non-bare release targets of the same checkout (or the core is itself). */
function checkBareLinks(target, bySlug) {
  for (const field of ['core', 'cli']) {
    const slug = target.bare[field];
    if (slug === null || slug === target.slug) continue;
    const linked = bySlug.get(slug);
    const where = `bare release target ${JSON.stringify(target.slug)} (${target.source})`;
    if (!linked) throw new ReleaseTargetError('invalid-bare-target', `${where} names ${field} slug ${JSON.stringify(slug)}, which has no release target`, { slug: target.slug, [field]: slug });
    if (linked.bare) throw new ReleaseTargetError('invalid-bare-target', `${where} names ${field} slug ${JSON.stringify(slug)}, which is itself a bare release target`, { slug: target.slug, [field]: slug });
  }
}

/** Splits `<package-slug>-v<strict-semver>` into its slug, version and prerelease (undefined for a stable version). */
export function parseReleaseTag(tag) {
  const match = typeof tag === 'string' && tag.match(tagPattern);
  if (!match) throw new Error(`Unsupported tag format: ${tag}. Expected <package-slug>-v<strict-semver>.`);
  const [, slug, version, prerelease] = match;
  return { slug, version, prerelease };
}

export async function resolveReleaseTag(tag, { root = repoRoot } = {}) {
  const { slug, version, prerelease } = parseReleaseTag(tag);
  const distTag = prerelease ? prerelease.split('.')[0] : 'latest';
  // npm rejects dist-tags that parse as version ranges; prereleases must never
  // move latest, even when someone names the prerelease "latest".
  if (prerelease && (!/^[a-z][a-z0-9-]*$/.test(distTag) || /^(?:v[0-9]|x$)/.test(distTag) || distTag === 'latest')) {
    throw new Error(`Unsafe prerelease dist-tag: ${distTag}`);
  }
  const targets = await loadReleaseTargets({ root });
  const target = targets.find(candidate => candidate.slug === slug);
  if (!target) throw new Error(`No publishable workspace found for slug "${slug}"`);
  const manifest = JSON.parse(await readFile(path.join(root, target.path, 'package.json'), 'utf8'));
  if (manifest.private === true) throw new Error(`Cannot publish private package ${target.name}`);
  if (manifest.name !== target.name) throw new Error(`Release target ${slug} expected ${target.name}, found ${manifest.name}`);
  if (manifest.version !== version) throw new Error(`Tag version ${version} does not match ${target.name}@${manifest.version}`);
  if (manifest.publishConfig?.tag && manifest.publishConfig.tag !== distTag) {
    throw new Error(`publishConfig.tag ${manifest.publishConfig.tag} conflicts with resolved dist-tag ${distTag}`);
  }
  return { tag, slug, name: target.name, version, path: target.path, distTag, ...(target.bare && { bare: target.bare }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await resolveReleaseTag(process.argv[2] ?? process.env.GITHUB_REF_NAME);
    if (process.env.GITHUB_OUTPUT) {
      const outputs = { pkg_slug: result.slug, pkg_name: result.name, pkg_version: result.version, pkg_path: result.path, dist_tag: result.distTag };
      await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
