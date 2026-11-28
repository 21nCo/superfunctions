// Bare release gate: a product's bare (unscoped) npm package is its front door, released at the same version as the
// product's scoped core and CLI (AGENTS.md, "Bare npm package names"). release-packages.json marks it with
// "kind": "bare" and names the release slugs of the scoped `core` it re-exports and of the scoped `cli`. The build job of publish-tag.yml runs this gate before installing anything; on any other release it does
// nothing.
//
//   node scripts/assert-bare-release.mjs <slug>-v<version> [--root <checkout>] [--registry <url>]
//
// It refuses the release unless, at the tag commit:
//   - the bare package, its scoped core and its scoped CLI all have the tagged version;
//   - the bare package has exactly the template's shape (TEMPLATE): type "module", no main or imports, and either the
//     template's exports and re-export files with exactly the core as its only dependency (and, with a CLI, exactly
//     the CLI as its only devDependency), or (CLI-only) no exports and exactly the CLI as its only dependency; its
//     test script runs the template's front-door test (bare-front-door-test.mjs, copied byte for byte), which the
//     release build runs after installing the pinned core and CLI from npm;
//   - every bin is "./bin/cli.mjs", the shared shim (bare-cli-shim.mjs, copied byte for byte), which runs exactly that
//     version of the CLI named in "frontDoor": { "cli" };
//   - the CLI declares that it checks BARE_EXPECTED_CLI, which the shim sets to "<cli>@<version>", and refuses to run as
//     any other version (npm exec can reach another installed version under the bin name);
//   - the core and the CLI are already on npm at that version, so the bare package never points at a missing release.
// checkBareManifests (everything but the registry) also runs in CI over every bare target of the checkout.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadReleaseTargets, resolveReleaseTag } from './resolve-release-tag.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
export const SHIM_TEMPLATE = path.join(import.meta.dirname, 'bare-cli-shim.mjs');
/** The shared front-door test, copied byte for byte to test/front-door.test.mjs in every bare package. */
export const FRONT_DOOR_TEST_TEMPLATE = path.join(import.meta.dirname, 'bare-front-door-test.mjs');
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

/**
 * The exact shape of a bare package made from the template (README, "Bare packages"). A bare package re-exporting a
 * separate core has `exports` and the two re-export files below and nothing else to resolve; a CLI-only bare package
 * has no module entry at all. Every bin is the shim, and the package's test is the shared front-door test.
 */
export const TEMPLATE = Object.freeze({
  type: 'module',
  bin: './bin/cli.mjs',
  testFile: 'test/front-door.test.mjs',
  testScript: 'node --test test/front-door.test.mjs',
  exports: Object.freeze({ '.': Object.freeze({ types: './index.d.ts', import: './index.js', default: './index.js' }) }),
  /** The files the exports name, by path, as a function of the core's package name. */
  reexportFiles: Object.freeze({ 'index.js': core => `export * from '${core}';\n`, 'index.d.ts': core => `export * from '${core}';\n` }),
});

/** A bare release entry's shape: re-exporting a separate core, or CLI-only. */
export function bareKind({ core }) {
  return core === undefined || core === null ? 'cli-only' : 'reexport';
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = value => (value === undefined ? 'nothing' : JSON.stringify(value));

/**
 * Checks a bare target's manifests (and its template files) against the template and its scoped core and CLI, without
 * the registry. Returns the scoped packages the release depends on ({ slug, name, version, bins?, forbid? }), for the
 * registry check.
 * @param {{ root?: string, target: { slug: string, name: string, path: string, bare: { core: string | null, cli: string | null } }, targets?: Awaited<ReturnType<typeof loadReleaseTargets>>, shimTemplate?: string }} input
 */
export async function checkBareManifests({ root = repoRoot, target, targets, shimTemplate = SHIM_TEMPLATE, testTemplate = FRONT_DOOR_TEST_TEMPLATE }) {
  targets ??= await loadReleaseTargets({ root });
  const bySlug = new Map(targets.map(candidate => [candidate.slug, candidate]));
  const manifest = await readManifest(root, target);
  const { version } = manifest;
  const problems = [];
  const where = `${target.name} (${target.path})`;
  const linked = {};
  const scopedManifests = {};
  for (const field of ['core', 'cli']) {
    const slug = target.bare[field];
    if (slug === null) continue;
    const scoped = bySlug.get(slug);
    const scopedManifest = await readManifest(root, scoped);
    linked[field] = { slug, name: scoped.name, version: scopedManifest.version };
    scopedManifests[field] = scopedManifest;
    if (scopedManifest.private === true) problems.push(`its ${field} ${scoped.name} is private`);
    if (scopedManifest.version !== version) {
      problems.push(`its ${field} ${scoped.name} is at ${scopedManifest.version}, not ${version}; release the bare package at the same version as ${scoped.name}`);
    }
  }
  const cliName = target.bare.cli === null ? null : bySlug.get(target.bare.cli).name;
  const expect = (field, wanted, why) => {
    if (!same(manifest[field], wanted)) problems.push(`${field} must be ${show(wanted)}${why ? ` (${why})` : ''}, not ${show(manifest[field])}`);
  };
  const readOwn = async file => {
    try {
      return await readFile(path.join(root, target.path, file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  // Module entry points: exactly the template's.
  expect('type', TEMPLATE.type);
  expect('main', undefined, 'the template resolves only through exports');
  expect('imports', undefined);
  expect('exports', linked.core ? TEMPLATE.exports : undefined, linked.core ? `the template's re-export of ${linked.core.name}` : 'a CLI-only bare package exports no modules');
  if (linked.core) {
    for (const [file, content] of Object.entries(TEMPLATE.reexportFiles)) {
      if ((await readOwn(file)) !== content(linked.core.name)) problems.push(`${file} must be exactly ${JSON.stringify(content(linked.core.name))}`);
    }
  }
  // Dependencies: exactly the pinned core, or for a CLI-only bare package exactly the pinned CLI. A bare package with
  // both has the CLI as its only devDependency, so its front-door test can run the bin without npm.
  const pinned = linked.core ? linked.core.name : cliName;
  if (pinned !== null) expect('dependencies', { [pinned]: version }, `exactly ${pinned} at ${version}`);
  expect('devDependencies', linked.core && cliName !== null ? { [cliName]: version } : undefined, linked.core && cliName !== null ? `exactly ${cliName} at ${version}, for the front-door test` : undefined);
  for (const field of ['optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies']) expect(field, undefined);
  // The release build runs the package's test script after installing the pinned core and CLI from npm: it must be
  // the shared front-door test, which imports the bare package and runs each bin.
  if (manifest.scripts?.test !== TEMPLATE.testScript) problems.push(`scripts.test must be ${JSON.stringify(TEMPLATE.testScript)}, not ${show(manifest.scripts?.test)}`);
  const testFile = await readOwn(TEMPLATE.testFile);
  if (testFile === null) problems.push(`${TEMPLATE.testFile} is missing; copy the shared front-door test template there`);
  else if (testFile !== (await readFile(testTemplate, 'utf8'))) problems.push(`${TEMPLATE.testFile} differs from the shared front-door test template; copy it again`);

  if (cliName !== null) {
    const cliManifest = scopedManifests.cli;
    if (!same(manifest.frontDoor, { cli: cliName })) problems.push(`frontDoor must be ${JSON.stringify({ cli: cliName })}, not ${show(manifest.frontDoor)}`);
    const bins = manifest.bin !== null && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? manifest.bin : {};
    if (!Object.hasOwn(bins, target.name)) problems.push(`bin must map "${target.name}" to ${TEMPLATE.bin}`);
    const cliBins = cliManifest.bin !== null && typeof cliManifest.bin === 'object' ? cliManifest.bin : {};
    if (!Object.hasOwn(cliBins, target.name)) problems.push(`its CLI ${cliName} has no "${target.name}" bin for ${SHIM_FILE} to run`);
    // npm exec can run another installed version of the CLI under the bin name; the CLI then refuses, because the
    // shim tells it the exact version expected in BARE_EXPECTED_CLI.
    if (cliManifest.frontDoorCli?.checksExpectedVersion !== true) {
      problems.push(`its CLI ${cliName} must check BARE_EXPECTED_CLI at startup and declare it with "frontDoorCli": { "checksExpectedVersion": true }`);
    }
    for (const [name, file] of Object.entries(bins)) {
      if (file !== TEMPLATE.bin) problems.push(`bin "${name}" must be ${JSON.stringify(TEMPLATE.bin)}, not ${JSON.stringify(file)}`);
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
  } else {
    if (manifest.frontDoor !== undefined) problems.push('frontDoor applies only to a bare target with a "cli" slug');
    if (manifest.bin !== undefined) problems.push('bin applies only to a bare target with a "cli" slug');
  }
  if (linked.core && cliName !== null) {
    for (const dependency of installedDependencies(scopedManifests.core, cliName)) problems.push(`its core ${linked.core.name} must not depend on its CLI (${dependency})`);
  }
  if (problems.length > 0) {
    throw new BareReleaseError('misaligned', `Bare package ${where} at ${version} does not match the bare template, its core and its CLI:\n  - ${problems.join('\n  - ')}`, { slug: target.slug, problems });
  }
  if (linked.cli) linked.cli.bins = Object.keys(manifest.bin);
  // Installing the core must not install the CLI either.
  if (linked.core && cliName !== null) linked.core.forbid = [cliName];
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
      if (body.frontDoorCli?.checksExpectedVersion !== true) {
        throw new BareReleaseError('not-published', `${name}@${version} on npm does not declare that it checks BARE_EXPECTED_CLI ("frontDoorCli": { "checksExpectedVersion": true }); release a new CLI version that does, at the bare package's version.`, { name, version });
      }
      const published = body.bin !== null && typeof body.bin === 'object' ? body.bin : {};
      const files = bins.map(bin => normalizeBin(published[bin]));
      if (files.some(file => typeof file !== 'string') || new Set(files).size !== 1) {
        throw new BareReleaseError('not-published', `${name}@${version} on npm does not have the bins ${bins.join(', ')} on one file (it has ${JSON.stringify(published)}); release a new CLI version that has them, at the bare package's version.`, { name, version });
      }
    }
  }
}

/**
 * Checks the packed tarball itself: its package.json keeps the checked version, pins, bins and frontDoor, and its shim
 * is the shared template, so an install, build or pack lifecycle script cannot change what the gate approved. The
 * release passes the manifest and template as committed at the tag (gitFile), not as they are on disk after those
 * scripts ran.
 * @param {{ tarball: string, manifest: Record<string, unknown>, shim?: string, kind: 'reexport' | 'cli-only', core?: string }} input
 *   `shim` is the shim template's text; `kind` is the bare package's shape (bareKind); `core` is the core's package
 *   name when it re-exports a separate core
 */
export async function checkPackedBare({ tarball, manifest, shim: template, kind, core }) {
  template ??= await readFile(SHIM_TEMPLATE, 'utf8');
  const tar = args => execFileSync('tar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const files = new Set(tar(['-tzf', tarball]).split(/\r?\n/).filter(Boolean).map(entry => entry.replace(/^\.\//, '')));
  const read = file => (files.has(`package/${file}`) ? tar(['-xzOf', tarball, `package/${file}`]) : undefined);
  const packedManifest = read('package.json');
  if (packedManifest === undefined) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has no package.json`);
  const packed = JSON.parse(packedManifest);
  const fields = ['name', 'version', 'type', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'exports', 'imports', 'main', 'frontDoor'];
  const changed = fields.filter(field => JSON.stringify(packed[field]) !== JSON.stringify(manifest[field]));
  const binsOf = value => JSON.stringify(Object.entries(value ?? {}).map(([name, file]) => [name, normalizeBin(file)]).sort());
  if (binsOf(packed.bin) !== binsOf(manifest.bin)) changed.push('bin');
  if (changed.length > 0) throw new BareReleaseError('misaligned', `The packed ${manifest.name} changed ${changed.join(', ')} after the bare release gate checked them`);
  if (manifest.frontDoor !== undefined) {
    const shim = read(SHIM_FILE);
    if (shim === undefined) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has no ${SHIM_FILE}`);
    if (shim !== template) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has a ${SHIM_FILE} that differs from the shared shim template`);
  }
  // A bare package re-exporting its core ships the template's re-export files, as checked.
  if (kind === 'reexport') {
    for (const [file, content] of Object.entries(TEMPLATE.reexportFiles)) {
      if (read(file) !== content(core)) throw new BareReleaseError('misaligned', `The packed ${manifest.name} has no ${file} re-exporting ${core}`);
    }
  }
  // A CLI-only bare package exports no modules, so it ships none of the files Node's legacy resolution imports.
  if (kind === 'cli-only') {
    const implicit = ['index.js', 'index.json', 'index.node'].filter(file => files.has(`package/${file}`));
    if (implicit.length > 0) throw new BareReleaseError('misaligned', `The packed ${manifest.name} is CLI-only but ships ${implicit.join(', ')}, which import "${manifest.name}" would load`);
  }
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
