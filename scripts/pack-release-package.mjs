import { execFileSync } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SHIM_FILE, TEMPLATE, bareKind, checkPackedBare, gitFile } from './assert-bare-release.mjs';
import { REPOS } from './owners.mjs';
import { RELEASE_BASE_FILE, releaseOverlayFile, resolveReleaseTag } from './resolve-release-tag.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** A release slug's entry as committed at HEAD, in release-packages.json or a repository overlay. */
function committedReleaseEntry(slug) {
  for (const file of [RELEASE_BASE_FILE, ...REPOS.filter(repo => repo !== 'public').map(releaseOverlayFile)]) {
    let entries;
    try {
      entries = JSON.parse(gitFile(root, file));
    } catch (error) {
      if (file !== RELEASE_BASE_FILE && /does not exist|exists on disk, but not in/.test(String(error.stderr ?? error.message))) continue;
      throw error;
    }
    const entry = Array.isArray(entries) ? entries.find(candidate => candidate?.slug === slug) : undefined;
    if (entry) return entry;
  }
  throw new Error(`Release slug ${slug} is not in the committed release files`);
}
// The target may come from release-packages.json or the repository overlay; both are read from this checkout.
const target = await resolveReleaseTag(process.argv[2] ?? process.env.RELEASE_TAG, { root });
const cwd = path.join(root, target.path);
const manifestFile = path.join(cwd, 'package.json');
const manifestSource = await readFile(manifestFile, 'utf8');
const manifest = JSON.parse(manifestSource);
const npm = (...args) => execFileSync('npm', args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
for (const script of ['build', 'test']) {
  if (!manifest.scripts?.[script]) throw new Error(`${target.name} is missing required release script "${script}"`);
}
// Generated release inputs must already be committed at the immutable tag.
// In particular, generating registry catalogs here would invalidate their signature.
const typecheck = manifest.scripts?.typecheck ? 'typecheck' : 'type-check';
for (const script of ['generate:check', 'build', typecheck, 'test']) {
  if (manifest.scripts?.[script]) npm('run', script);
}
// A bare package's front-door test must run even if an install, build or test hook rewrote its test script or the
// files it reads: the package's manifest, re-export files, shim and test, as committed at the tag, are put in place
// for it (the test file must be the committed template), it runs directly with Node after the pinned core and CLI
// were installed from npm, and the working files are restored afterwards.
const committedTarget = committedReleaseEntry(target.slug);
if (committedTarget.kind === 'bare') {
  const committedFile = file => {
    try {
      return gitFile(root, path.posix.join(committedTarget.path, file));
    } catch {
      return null;
    }
  };
  if (committedFile(TEMPLATE.testFile) !== gitFile(root, 'scripts/bare-front-door-test.mjs')) {
    throw new Error(`${target.name}: ${TEMPLATE.testFile} is not the front-door test template committed at the tag`);
  }
  const pinned = ['package.json', ...Object.keys(TEMPLATE.reexportFiles), SHIM_FILE, TEMPLATE.testFile];
  // Each working file replaced so far, with its previous content (null: there was none), restored in finally even
  // when staging fails part-way.
  const working = new Map();
  try {
    for (const file of pinned) {
      const content = committedFile(file);
      if (content === null) continue;
      const absolute = path.join(cwd, file);
      // Only regular files inside the package are replaced: a link (even a dangling one) or anything else there, or a
      // folder that resolves outside the package, is refused before anything is written.
      let stats = null;
      try {
        stats = await lstat(absolute);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (stats !== null && !stats.isFile()) throw new Error(`${target.name}: ${file} is not a regular file; refusing to stage the front-door test over it`);
      await mkdir(path.dirname(absolute), { recursive: true });
      const folder = path.relative(await realpath(cwd), await realpath(path.dirname(absolute)));
      if (folder.startsWith('..') || path.isAbsolute(folder)) throw new Error(`${target.name}: ${file} resolves outside the package; refusing to stage the front-door test`);
      const previous = stats === null ? null : await readFile(absolute, 'utf8');
      working.set(absolute, previous);
      await writeFile(absolute, content);
    }
    // NODE_TEST_CONTEXT would make node --test report to an enclosing test runner instead of exiting non-zero.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    execFileSync(process.execPath, ['--test', TEMPLATE.testFile], { cwd, stdio: 'inherit', env: { ...env, CI: 'true', BARE_CLI_NO_NPM: '1' } });
  } finally {
    for (const [absolute, content] of working) {
      if (content === null) await rm(absolute, { force: true });
      else await writeFile(absolute, content);
    }
  }
}
// Run pack lifecycle hooks once; publishing this exact tarball cannot rebuild
// a different artifact in prepublishOnly/prepare/prepack.
const destination = await mkdtemp(path.join(tmpdir(), 'npm-release-'));
// Tarball publication reads its embedded manifest outside the Git checkout.
// Preserve commit lineage in that artifact without leaving source mutations.
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
let packed;
try {
  await writeFile(manifestFile, `${JSON.stringify({ ...manifest, gitHead }, null, 2)}\n`);
  packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--foreground-scripts=false', '--pack-destination', destination], { cwd, encoding: 'utf8' }));
} finally {
  await writeFile(manifestFile, manifestSource);
}
if (packed.length !== 1 || packed[0].name !== target.name || packed[0].version !== target.version) {
  throw new Error('Packed artifact identity does not match resolved release target');
}
const tarball = path.join(destination, packed[0].filename);
// A bare package's tarball must still hold what assert-bare-release.mjs checked at the tag commit, whatever the
// install, build and pack scripts did to the checkout since: whether the slug is bare, its path, its manifest and the
// shim template all come from the commit, not the working tree.
const committed = committedTarget;
if (committed.path !== target.path) throw new Error(`Release target ${target.slug} is at ${committed.path} in the commit, not ${target.path}`);
if (committed.kind === 'bare') {
  await checkPackedBare({
    tarball,
    manifest: JSON.parse(gitFile(root, path.posix.join(committed.path, 'package.json'))),
    shim: gitFile(root, 'scripts/bare-cli-shim.mjs'),
    kind: bareKind(committed),
    core: bareKind(committed) === 'reexport' ? committedReleaseEntry(committed.core).name : undefined,
  });
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
console.log(JSON.stringify({ ...target, gitHead, tarball, integrity: packed[0].integrity }, null, 2));
