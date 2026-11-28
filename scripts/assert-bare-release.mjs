// Bare release gate: a product's bare (unscoped) npm package is its front door, released at the same version as the
// product's scoped core and CLI (AGENTS.md, "Bare npm package names"). release-packages.json marks it with
// "kind": "bare" and names the release slugs of its `core` (its own slug when the bare package is the core itself) and
// `cli`. The build job of publish-tag.yml runs this gate before installing anything; on any other release it does
// nothing.
//
//   node scripts/assert-bare-release.mjs <slug>-v<version> [--root <checkout>] [--registry <url>]
//
// It refuses the release unless, at the tag commit:
//   - the bare package, its scoped core and its scoped CLI all have the tagged version;
//   - the bare package depends on exactly that version of the core (when the core is another package);
//   - the bare package's bins run the CLI through the shared shim (bare-cli-shim.mjs, copied byte for byte to
//     bin/cli.mjs), which runs exactly that version of the CLI named in "frontDoor": { "cli" }. A bare package that
//     also exports a core keeps the CLI out of its dependencies (at most an optional peer at that version); a CLI-only
//     bare package depends on exactly that version of it;
//   - the core and the CLI are already on npm at that version, so the bare package never points at a missing release.
// checkBareManifests (everything but the registry) also runs in CI over every bare target of the checkout.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadReleaseTargets, resolveReleaseTag } from './resolve-release-tag.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
export const SHIM_TEMPLATE = path.join(import.meta.dirname, 'bare-cli-shim.mjs');
/** Where a bare package keeps its copy of the shim, relative to the package. */
export const SHIM_FILE = 'bin/cli.mjs';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export class BareReleaseError extends Error {
  /**
   * @param {'misaligned' | 'not-published' | 'registry-unavailable' | 'usage'} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BareReleaseError';
    this.code = code;
    this.details = details;
  }
}

/** A file as committed at `rev` (default HEAD) in the checkout at `root`. */
export function gitFile(root, file, rev = 'HEAD') {
  return execFileSync('git', ['show', `${rev}:${file.split(path.sep).join('/')}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

async function readManifest(root, target) {
  return JSON.parse(await readFile(path.join(root, target.path, 'package.json'), 'utf8'));
}

const normalizeBin = file => (typeof file === 'string' ? path.posix.normalize(file.replaceAll('\\', '/')).replace(/^\.\//, '') : file);

/** Every string target in an `exports` value, at any depth. */
function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

/**
 * Checks a bare target's manifests (and its shim copy) against its scoped core and CLI, without the registry.
 * Returns the scoped packages the release depends on ({ slug, name, version }), for the registry check.
 * @param {{ root?: string, target: { slug: string, name: string, path: string, bare: { core: string | null, cli: string | null } }, targets?: Awaited<ReturnType<typeof loadReleaseTargets>>, shimTemplate?: string }} input
 */
export async function checkBareManifests({ root = repoRoot, target, targets, shimTemplate = SHIM_TEMPLATE }) {
  targets ??= await loadReleaseTargets({ root });
  const bySlug = new Map(targets.map(candidate => [candidate.slug, candidate]));
  const manifest = await readManifest(root, target);
  const { version } = manifest;
  const problems = [];
  const where = `${target.name} (${target.path})`;
  const linked = {};
  const scopedManifests = {};
  let cliBinNames = [];
  for (const field of ['core', 'cli']) {
    const slug = target.bare[field];
    if (slug === null || slug === target.slug) continue;
    const scoped = bySlug.get(slug);
    const scopedManifest = await readManifest(root, scoped);
    linked[field] = { slug, name: scoped.name, version: scopedManifest.version };
    scopedManifests[field] = scopedManifest;
    if (scopedManifest.private === true) problems.push(`its ${field} ${scoped.name} is private`);
    if (scopedManifest.version !== version) {
      problems.push(`its ${field} ${scoped.name} is at ${scopedManifest.version}, not ${version}; release the bare package at the same version as ${scoped.name}`);
    }
  }
  const dependencies = manifest.dependencies ?? {};
  // An exact pin lives in dependencies alone: npm lets an optionalDependencies entry of the same name override it, and
  // a peer entry would add a second range for the same package.
  const pinnedOnlyInDependencies = name => {
    if (dependencies[name] !== version) problems.push(`dependencies["${name}"] must be exactly ${version}, not ${JSON.stringify(dependencies[name] ?? null)}`);
    for (const field of ['optionalDependencies', 'peerDependencies']) {
      if (manifest[field]?.[name] !== undefined) problems.push(`${field} must not list ${name}; its exact pin belongs in dependencies alone`);
    }
  };
  if (linked.core) pinnedOnlyInDependencies(linked.core.name);
  if (target.bare.core !== null && !hasRootExport(manifest)) {
    problems.push(`exports must have a "." entry that an ESM import resolves (a string, or an import, node or default condition), so import "${target.name}" gives the core`);
  }
  const hasCore = target.bare.core !== null;
  if (target.bare.cli !== null) {
    const cliName = bySlug.get(target.bare.cli).name;
    const cliManifest = await readManifest(root, bySlug.get(target.bare.cli));
    if (manifest.frontDoor?.cli !== cliName) problems.push(`frontDoor.cli must be "${cliName}", not ${JSON.stringify(manifest.frontDoor?.cli ?? null)}`);
    const bins = manifest.bin !== null && typeof manifest.bin === 'object' ? manifest.bin : {};
    if (!Object.hasOwn(bins, target.name)) problems.push(`bin must map "${target.name}" to ${SHIM_FILE}`);
    const cliBins = cliManifest.bin !== null && typeof cliManifest.bin === 'object' ? cliManifest.bin : {};
    if (!Object.hasOwn(cliBins, target.name)) problems.push(`its CLI ${cliName} has no "${target.name}" bin for ${SHIM_FILE} to run`);
    for (const [name, file] of Object.entries(bins)) {
      if (normalizeBin(file) !== SHIM_FILE) problems.push(`bin "${name}" must be ${SHIM_FILE}, not ${JSON.stringify(file)}`);
      else if (name !== target.name && normalizeBin(cliBins[name]) !== normalizeBin(cliBins[target.name])) {
        problems.push(`bin "${name}" runs the CLI's "${target.name}" bin, so ${cliName} must have a "${name}" bin with the same file`);
      }
    }
    let shim = null;
    try {
      shim = await readFile(path.join(root, target.path, SHIM_FILE), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (shim === null) problems.push(`${SHIM_FILE} is missing; copy the shared shim template there`);
    else if (shim !== (await readFile(shimTemplate, 'utf8'))) problems.push(`${SHIM_FILE} differs from the shared shim template; copy it again`);
    if (Array.isArray(manifest.files) && !manifest.files.some(entry => ['bin', 'bin/', SHIM_FILE].includes(normalizeBin(entry)))) {
      problems.push(`files must include ${SHIM_FILE}`);
    }
    if (exportTargets(manifest.exports).some(file => normalizeBin(file).startsWith('bin/'))) problems.push('exports must not reach the bin folder');
    cliBinNames = Object.keys(bins);
    const peer = manifest.peerDependencies?.[cliName];
    // An npm alias ("x": "npm:@scope/cli@1.2.3"; npm reads the scheme in any case) installs the CLI under another name.
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [alias, spec] of Object.entries(manifest[field] ?? {})) {
        if (alias !== cliName && aliasTarget(spec) === cliName) problems.push(`${field}["${alias}"] installs ${cliName} through an npm alias`);
      }
    }
    if (hasCore) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        if (manifest[field]?.[cliName] !== undefined) problems.push(`${field} must not list ${cliName}: importers of the core would install the CLI; ${SHIM_FILE} makes it available when it runs`);
      }
      if (peer !== undefined && (peer !== version || manifest.peerDependenciesMeta?.[cliName]?.optional !== true)) {
        problems.push(`peerDependencies may list ${cliName} only as an optional peer at exactly ${version}`);
      }
    } else {
      pinnedOnlyInDependencies(cliName);
    }
  } else if (manifest.frontDoor !== undefined) {
    problems.push('frontDoor applies only to a bare target with a "cli" slug');
  }
  if (linked.core && target.bare.cli !== null) {
    const cliName = bySlug.get(target.bare.cli).name;
    for (const dependency of installedDependencies(scopedManifests.core, cliName)) problems.push(`its core ${linked.core.name} must not depend on its CLI (${dependency})`);
  }
  if (problems.length > 0) {
    throw new BareReleaseError('misaligned', `Bare package ${where} at ${version} does not match its core and CLI:\n  - ${problems.join('\n  - ')}`, { slug: target.slug, problems });
  }
  if (linked.cli) linked.cli.bins = cliBinNames;
  // Installing the core must not install the CLI either.
  if (linked.core && target.bare.cli !== null) linked.core.forbid = [bySlug.get(target.bare.cli).name];
  return { version, packages: Object.values(linked) };
}

/**
 * The dependency entries of a manifest that install `name` for its importers, directly or through an npm alias:
 * dependencies, optionalDependencies, and peerDependencies not marked optional (npm installs required peers).
 */
function installedDependencies(manifest, name) {
  const found = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [key, spec] of Object.entries(manifest?.[field] ?? {})) {
      if (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[key]?.optional === true) continue;
      if (key === name || aliasTarget(spec) === name) found.push(`${field}["${key}"]`);
    }
  }
  return found;
}

/** The package an npm alias spec ("npm:<name>" or "npm:<name>@<range>", scheme in any case) installs, or null. */
function aliasTarget(spec) {
  const match = typeof spec === 'string' && /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/i.exec(spec.trim());
  return match ? match[1] : null;
}

// The conditions Node.js 22 and later match for `import "<bare>"` by default; a require-only root cannot be imported.
const IMPORT_CONDITIONS = ['import', 'node', 'node-addons', 'module-sync', 'default'];

/**
 * The target Node.js selects for an ESM import from an exports value: the first key, in order, that is a matching
 * condition decides (a nested object that matches nothing lets the next key try); null blocks the import; an array
 * takes its first valid target; a target must start with "./". Returns the target, null (blocked or invalid), or
 * undefined (no condition matched).
 */
function resolveImport(value) {
  if (typeof value === 'string') return value.startsWith('./') ? value : null;
  if (Array.isArray(value)) {
    // The first valid target wins; an array whose entries all match no condition matches nothing (undefined), so the
    // next condition can try; a blocked or invalid entry makes it null.
    let last;
    for (const candidate of value) {
      const target = resolveImport(candidate);
      if (typeof target === 'string') return target;
      if (target === null) last = null;
    }
    return last;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, candidate] of Object.entries(value)) {
    if (!IMPORT_CONDITIONS.includes(key)) continue;
    const target = resolveImport(candidate);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** The file `import "<bare>"` resolves to: the root of `exports`, or (with no exports) the main file; null if none. */
function rootImportTarget(manifest) {
  const { exports } = manifest;
  if (exports === undefined) return typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : null;
  let root = exports;
  if (exports !== null && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith('.'))) root = exports['.'];
  // Otherwise a string, an array or a conditions-only object is the "." entry itself.
  const target = resolveImport(root);
  return typeof target === 'string' ? target : null;
}

const hasRootExport = manifest => rootImportTarget(manifest) !== null;

/**
 * The entries of a gzipped tar archive (an npm tarball), by path without a leading "./": { type, data }, where type is
 * the tar type flag ("0" for a regular file, "2" for a symlink, "5" for a folder). Reads ustar prefixes, GNU long
 * names and pax path records, which npm uses for long paths.
 * @param {Buffer} gzipped
 */
export function readTarball(gzipped) {
  const data = gunzipSync(gzipped);
  const text = bytes => bytes.toString('utf8').replace(/\0[\s\S]*$/, '');
  const entries = new Map();
  let longName = null;
  let paxPath = null;
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    // A header's checksum is the sum of its bytes with the checksum field read as spaces; tar readers (npm's
    // included) reject an entry whose stored checksum differs.
    const stored = Number.parseInt(text(header.subarray(148, 156)).trim(), 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (stored !== sum) throw new Error(`invalid tar header checksum at byte ${offset}`);
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`unreadable tar entry size at byte ${offset}`);
    // The entry's body is padded to whole 512-byte blocks, which must all be present.
    if (offset + 512 + Math.ceil(size / 512) * 512 > data.length) throw new Error(`tar entry at byte ${offset} runs past the end of the archive`);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const prefix = text(header.subarray(257, 262)) === 'ustar' ? text(header.subarray(345, 500)) : '';
    const name = prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100));
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
      continue;
    }
    if (type === 'L') {
      longName = text(body);
      continue;
    }
    if (type === 'g') continue;
    entries.set((paxPath ?? longName ?? name).replace(/^\.\//, ''), { type: type === '7' ? '0' : type, data: Buffer.from(body) });
    paxPath = longName = null;
  }
  return entries;
}

/** The regular file at `file` in a tarball's entries, or undefined (a symlink or folder there does not count). */
const regularFile = (entries, file) => {
  const entry = entries.get(`package/${normalizeBin(file)}`);
  return entry?.type === '0' ? entry.data : undefined;
};

/**
 * Requires every scoped package to be on the registry at its version. Any answer but the version itself refuses.
 * @param {{ slug: string, name: string, version: string }[]} packages
 * @param {{ registry?: string, fetch?: typeof globalThis.fetch }} [options]
 */
export async function assertPublished(packages, { registry = DEFAULT_REGISTRY, fetch = globalThis.fetch } = {}) {
  const base = registry.replace(/\/+$/, '');
  for (const { slug, name, version, bins = [], forbid = [] } of packages) {
    const url = `${base}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
    let response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw new BareReleaseError('registry-unavailable', `Could not ask ${base} for ${name}@${version}: ${error.message}`, { name, version });
    }
    if (response.status === 404) {
      throw new BareReleaseError('not-published', `${name}@${version} is not on npm yet; release ${slug}-v${version} first, then tag the bare package again.`, { name, version });
    }
    if (!response.ok) throw new BareReleaseError('registry-unavailable', `${base} answered ${response.status} for ${name}@${version}`, { name, version });
    const body = await response.json();
    if (body?.name !== name || body?.version !== version) {
      throw new BareReleaseError('registry-unavailable', `${base} returned ${body?.name}@${body?.version} for ${name}@${version}`, { name, version });
    }
    for (const forbidden of forbid) {
      const dependencies = installedDependencies(body, forbidden);
      if (dependencies.length > 0) throw new BareReleaseError('misaligned', `${name}@${version} on npm depends on ${forbidden} (${dependencies.join(', ')}), so importers of the bare package would install the CLI`, { name, version });
    }
    // The shim runs the published CLI's bin named after the bare package; every other bare bin is an alias of it.
    if (bins.length > 0) {
      const published = body.bin !== null && typeof body.bin === 'object' ? body.bin : {};
      const files = bins.map(bin => normalizeBin(published[bin]));
      if (files.some(file => typeof file !== 'string') || new Set(files).size !== 1) {
        throw new BareReleaseError('not-published', `${name}@${version} on npm does not have the bins ${bins.join(', ')} on one file (it has ${JSON.stringify(published)}); release a new CLI version that has them, at the bare package's version.`, { name, version });
      }
      // The manifest can name a file the tarball lacks (or holds as a link, which npm does not install), so the
      // published tarball must hold it as a regular file.
      if (regularFile(await publishedTarball(body.dist?.tarball, { fetch, name, version }), files[0]) === undefined) {
        throw new BareReleaseError('not-published', `${name}@${version} on npm has no ${files[0]} for its ${bins[0]} bin; release a new CLI version that ships it, at the bare package's version.`, { name, version });
      }
    }
  }
}

/** The entries of a published tarball (readTarball). */
async function publishedTarball(url, { fetch, name, version }) {
  if (typeof url !== 'string' || url === '') throw new BareReleaseError('registry-unavailable', `The registry gave no tarball for ${name}@${version}`, { name, version });
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`answered ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new BareReleaseError('registry-unavailable', `Could not download the ${name}@${version} tarball: ${error.message}`, { name, version });
  }
  try {
    return readTarball(bytes);
  } catch (error) {
    throw new BareReleaseError('registry-unavailable', `Could not read the ${name}@${version} tarball: ${error.message}`, { name, version });
  }
}

/**
 * Checks the packed tarball itself: its package.json keeps the checked version, pins, bins and frontDoor, and its shim
 * is the shared template, so an install, build or pack lifecycle script cannot change what the gate approved. The
 * release passes the manifest and template as committed at the tag (gitFile), not as they are on disk after those
 * scripts ran.
 * @param {{ tarball: string, manifest: Record<string, unknown>, shim?: string }} input  `shim` is the template's text
 */
export async function checkPackedBare({ tarball, manifest, shim: template }) {
  template ??= await readFile(SHIM_TEMPLATE, 'utf8');
  const entries = readTarball(await readFile(tarball));
  const packedManifest = regularFile(entries, 'package.json');
  if (packedManifest === undefined) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has no package.json`);
  const packed = JSON.parse(packedManifest.toString('utf8'));
  const fields = ['name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'exports', 'main', 'frontDoor'];
  const changed = fields.filter(field => JSON.stringify(packed[field]) !== JSON.stringify(manifest[field]));
  const binsOf = value => JSON.stringify(Object.entries(value ?? {}).map(([name, file]) => [name, normalizeBin(file)]).sort());
  if (binsOf(packed.bin) !== binsOf(manifest.bin)) changed.push('bin');
  if (changed.length > 0) throw new BareReleaseError('misaligned', `The packed ${manifest.name} changed ${changed.join(', ')} after the bare release gate checked them`);
  if (manifest.frontDoor !== undefined) {
    const shim = regularFile(entries, SHIM_FILE);
    if (shim === undefined) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has no ${SHIM_FILE}`);
    if (shim.toString('utf8') !== template) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has a ${SHIM_FILE} that differs from the shared shim template`);
  }
  // The file `import "<bare>"` resolves to ships in the tarball.
  const root = rootImportTarget(manifest);
  if (root !== null && regularFile(entries, root) === undefined) throw new BareReleaseError('misaligned', `The packed ${manifest.name} lacks ${root}, which import "${manifest.name}" resolves to`);
}

/**
 * The gate: resolves the tag; for a bare target checks its manifests, then the registry.
 * @returns {Promise<{ bare: false } | { bare: true, name: string, version: string, packages: { slug: string, name: string, version: string }[] }>}
 */
export async function assertBareRelease(tag, { root = repoRoot, registry, fetch } = {}) {
  const target = await resolveReleaseTag(tag, { root });
  if (!target.bare) return { bare: false };
  const { version, packages } = await checkBareManifests({ root, target });
  await assertPublished(packages, { registry, fetch });
  return { bare: true, name: target.name, version, packages };
}

function parseArgs(args) {
  const options = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--root' && flag !== '--registry') {
      options.positionals.push(flag);
      continue;
    }
    const key = flag.slice(2);
    if (options[key] !== undefined || !args[index + 1]) throw new BareReleaseError('usage', `${flag} needs one value`);
    options[key] = args[(index += 1)];
  }
  if (options.positionals.length !== 1) throw new BareReleaseError('usage', 'Usage: assert-bare-release.mjs <slug>-v<version> [--root <checkout>] [--registry <url>]');
  return options;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { positionals, root, registry } = parseArgs(process.argv.slice(2));
    const [tag] = positionals;
    const result = await assertBareRelease(tag, { root: root ? path.resolve(root) : repoRoot, registry });
    if (!result.bare) console.log(`${tag}: not a bare package release; nothing to check.`);
    else {
      const scoped = result.packages.map(({ name, version }) => `${name}@${version}`).join(' and ');
      console.log(`${tag}: ${result.name}@${result.version} matches ${scoped}, already on npm.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
