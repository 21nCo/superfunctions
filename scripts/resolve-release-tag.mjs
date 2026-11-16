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
   * @param {'malformed-release-file' | 'invalid-target' | 'invalid-target-path' | 'duplicate-slug' | 'duplicate-name'} code
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
      bySlug.set(entry.slug, target);
      byName.set(entry.name, target);
      merged.push(target);
    }
  }
  return merged;
}

export async function resolveReleaseTag(tag, { root = repoRoot } = {}) {
  const match = typeof tag === 'string' && tag.match(tagPattern);
  if (!match) throw new Error(`Unsupported tag format: ${tag}. Expected <package-slug>-v<strict-semver>.`);
  const [, slug, version, prerelease] = match;
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
  return { tag, slug, name: target.name, version, path: target.path, distTag };
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
