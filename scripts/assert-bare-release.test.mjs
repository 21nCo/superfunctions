import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BareReleaseError, SHIM_FILE, SHIM_TEMPLATE, assertBareRelease, assertPublished, checkBareManifests, checkPackedBare, readTarball } from './assert-bare-release.mjs';
import { ReleaseTargetError, loadReleaseTargets } from './resolve-release-tag.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A checkout with a product: @fixture/core, @fixture/cli (bins fixture and fx) and the bare package `fixture`
 * (core export plus the shim), all at 1.2.3. `overrides` replaces whole manifest fields of the bare package.
 */
function product(t, { overrides = {}, entry = {}, cliVersion = '1.2.3', coreVersion = '1.2.3' } = {}) {
  const root = tempDir(t, 'bare-release-');
  writeJson(path.join(root, 'core/package.json'), { name: '@fixture/core', version: coreVersion });
  writeJson(path.join(root, 'cli/package.json'), { name: '@fixture/cli', version: cliVersion, bin: { fixture: './dist/cli.js', fx: './dist/cli.js' } });
  writeJson(path.join(root, 'bare/package.json'), {
    name: 'fixture',
    version: '1.2.3',
    exports: { '.': './index.js' },
    bin: { fixture: './bin/cli.mjs', fx: 'bin/cli.mjs' },
    files: ['bin', 'index.js'],
    frontDoor: { cli: '@fixture/cli' },
    dependencies: { '@fixture/core': '1.2.3' },
    ...overrides,
  });
  mkdirSync(path.join(root, 'bare/bin'));
  cpSync(SHIM_TEMPLATE, path.join(root, 'bare', SHIM_FILE));
  writeJson(path.join(root, 'release-packages.json'), [
    { slug: 'fixture-core', path: 'core', name: '@fixture/core' },
    { slug: 'fixture-cli', path: 'cli', name: '@fixture/cli' },
    { slug: 'fixture', path: 'bare', name: 'fixture', kind: 'bare', core: 'fixture-core', cli: 'fixture-cli', ...entry },
  ]);
  return root;
}

async function bareTarget(root) {
  const targets = await loadReleaseTargets({ root });
  return { target: targets.find(target => target.bare), targets };
}

async function problemsOf(root) {
  const { target, targets } = await bareTarget(root);
  try {
    await checkBareManifests({ root, target, targets });
    return [];
  } catch (error) {
    assert.ok(error instanceof BareReleaseError && error.code === 'misaligned', error.message);
    return error.details.problems;
  }
}

const registryAnswering = answers => async url => {
  const answer = answers[url];
  if (answer === undefined) return new Response('{}', { status: 404 });
  return new Response(Buffer.isBuffer(answer) ? answer : JSON.stringify(answer), { status: 200 });
};

const CLI_TARBALL = 'https://registry.example.test/@fixture/cli/-/cli-1.2.3.tgz';

/** The bytes of a packed @fixture/cli 1.2.3 holding `files` (bins fixture and fx on dist/cli.js). */
function cliTarball(t, files = ['dist/cli.js']) {
  const dir = tempDir(t, 'bare-release-cli-');
  writeJson(path.join(dir, 'package.json'), { name: '@fixture/cli', version: '1.2.3', bin: { fixture: './dist/cli.js', fx: './dist/cli.js' } });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), '#!/usr/bin/env node\n');
  }
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: dir, encoding: 'utf8' }));
  return readFileSync(path.join(dir, packed.filename));
}

const publishedCli = { name: '@fixture/cli', version: '1.2.3', bin: { fixture: './dist/cli.js', fx: './dist/cli.js' }, dist: { tarball: CLI_TARBALL } };

test('release targets: a bare entry names existing, non-bare core and CLI slugs', async t => {
  const root = product(t);
  const { target } = await bareTarget(root);
  assert.deepEqual(target.bare, { core: 'fixture-core', cli: 'fixture-cli' });
  const rejects = async (entry, pattern) => {
    const broken = product(t, { entry });
    await assert.rejects(loadReleaseTargets({ root: broken }), error => error instanceof ReleaseTargetError && error.code === 'invalid-bare-target' && pattern.test(error.message));
  };
  await rejects({ kind: 'facade' }, /"kind" must be "bare"/);
  await rejects({ core: undefined, cli: undefined }, /needs a "core" or a "cli"/);
  await rejects({ cli: 'fixture' }, /not the bare package itself/);
  await rejects({ cli: 'missing-cli' }, /"missing-cli", which has no release target/);
  await rejects({ core: '' }, /"core" must be a release slug/);
  await rejects({ name: '@fixture/bare' }, /unscoped npm name/);
  const plain = tempDir(t, 'bare-release-plain-');
  writeJson(path.join(plain, 'release-packages.json'), [{ slug: 'lib', path: 'lib', name: 'lib', cli: 'lib-cli' }]);
  await assert.rejects(loadReleaseTargets({ root: plain }), /apply only to "kind": "bare"/);
  const chained = product(t);
  const entries = JSON.parse(readFileSync(path.join(chained, 'release-packages.json'), 'utf8'));
  entries.push({ slug: 'other', path: 'bare', name: 'other', kind: 'bare', core: 'fixture' });
  writeJson(path.join(chained, 'release-packages.json'), entries);
  await assert.rejects(loadReleaseTargets({ root: chained }), /"fixture", which is itself a bare release target/);
});

test('manifests: core, CLI and bare package at one version, pinned exactly, with the shared shim', async t => {
  const root = product(t);
  const { target, targets } = await bareTarget(root);
  assert.deepEqual(await checkBareManifests({ root, target, targets }), {
    version: '1.2.3',
    packages: [
      { slug: 'fixture-core', name: '@fixture/core', version: '1.2.3', forbid: ['@fixture/cli'] },
      { slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3', bins: ['fixture', 'fx'] },
    ],
  });
});

test('manifests: each way a bare package can drift from its core and CLI is refused', async t => {
  const expectProblem = async (options, pattern) => {
    const problems = await problemsOf(product(t, options));
    assert.ok(problems.some(problem => pattern.test(problem)), `expected ${pattern} in ${JSON.stringify(problems)}`);
  };
  await expectProblem({ coreVersion: '1.2.2' }, /core @fixture\/core is at 1\.2\.2, not 1\.2\.3/);
  await expectProblem({ cliVersion: '1.3.0' }, /cli @fixture\/cli is at 1\.3\.0, not 1\.2\.3/);
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '^1.2.3' } } }, /dependencies\["@fixture\/core"\] must be exactly 1\.2\.3/);
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '1.2.3', '@fixture/cli': '1.2.3' } } }, /dependencies must not list @fixture\/cli/);
  await expectProblem({ overrides: { optionalDependencies: { '@fixture/cli': '1.2.3' } } }, /optionalDependencies must not list @fixture\/cli/);
  await expectProblem({ overrides: { peerDependencies: { '@fixture/cli': '1.2.3' } } }, /only as an optional peer/);
  await expectProblem({ overrides: { frontDoor: { cli: '@fixture/other' } } }, /frontDoor\.cli must be "@fixture\/cli"/);
  await expectProblem({ overrides: { bin: { fx: './bin/cli.mjs' } } }, /bin must map "fixture"/);
  await expectProblem({ overrides: { bin: { fixture: './bin/cli.mjs', fixturectl: './bin/cli.mjs' } } }, /"fixturectl" bin with the same file/);
  await expectProblem({ overrides: { bin: { fixture: './dist/cli.js' } } }, /bin "fixture" must be bin\/cli\.mjs/);
  await expectProblem({ overrides: { files: ['index.js'] } }, /files must include bin\/cli\.mjs/);
  await expectProblem({ overrides: { exports: { '.': './index.js', './cli': './bin/cli.mjs' } } }, /exports must not reach the bin folder/);
  await expectProblem({ overrides: { optionalDependencies: { '@fixture/core': '1.2.2' } } }, /optionalDependencies must not list @fixture\/core/);
  await expectProblem({ overrides: { peerDependencies: { '@fixture/core': '^1.2.0' } } }, /peerDependencies must not list @fixture\/core/);
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '1.2.3', 'cli-alias': 'npm:@fixture/cli@1.2.3' } } }, /dependencies\["cli-alias"\] installs @fixture\/cli through an npm alias/);
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '1.2.3', 'cli-alias': 'NPM:@fixture/cli@1.2.3' } } }, /dependencies\["cli-alias"\] installs @fixture\/cli/);
  await expectProblem({ overrides: { peerDependencies: { 'cli-alias': 'npm:@fixture/cli' } } }, /peerDependencies\["cli-alias"\] installs @fixture\/cli/);
  await expectProblem({ overrides: { exports: { '.': null } } }, /exports must have a "\." entry that an ESM import resolves/);
  await expectProblem({ overrides: { exports: { '.': { types: './index.d.ts' } } } }, /exports must have a "\." entry that an ESM import resolves/);
  await expectProblem({ entry: { core: 'fixture' }, overrides: { dependencies: {}, exports: { './sub': './sub.js' } } }, /exports must have a "\." entry/);
  await expectProblem({ overrides: { exports: { '.': { require: './index.cjs' } } } }, /exports must have a "\." entry that an ESM import resolves/);
  // Node.js takes the first matching condition in key order, so a blocking "node" ahead of "import" wins.
  await expectProblem({ overrides: { exports: { '.': { node: null, import: './index.js' } } } }, /exports must have a "\." entry that an ESM import resolves/);
  assert.deepEqual(await problemsOf(product(t, { overrides: { exports: { '.': { types: './index.d.ts', browser: { worker: './w.js' }, import: './index.js' } } } })), []);

  // Installing the core must not install the CLI.
  const coreDependsOnCli = product(t);
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', dependencies: { 'the-cli': 'NPM:@fixture/cli@1.2.3' } });
  assert.ok((await problemsOf(coreDependsOnCli)).some(problem => /its core @fixture\/core must not depend on its CLI \(dependencies\["the-cli"\]\)/.test(problem)));
  await expectProblem({ overrides: { exports: { './package.json': './package.json' } } }, /exports must have a "\." entry/);
  await expectProblem({ overrides: { exports: undefined } }, /exports must have a "\." entry/);
  // Root exports in their other forms pass.
  for (const exports of ['./index.js', { import: './index.js' }, { '.': { import: './index.js' } }]) assert.deepEqual(await problemsOf(product(t, { overrides: { exports } })), []);
  assert.deepEqual(await problemsOf(product(t, { overrides: { exports: undefined, main: './index.js' } })), []);

  const edited = product(t);
  writeFileSync(path.join(edited, 'bare', SHIM_FILE), `${readFileSync(SHIM_TEMPLATE, 'utf8')}// local change\n`);
  assert.ok((await problemsOf(edited)).some(problem => /differs from the shared shim template/.test(problem)));
  const missing = product(t);
  rmSync(path.join(missing, 'bare', SHIM_FILE));
  assert.ok((await problemsOf(missing)).some(problem => /bin\/cli\.mjs is missing/.test(problem)));

  // An optional peer at exactly the version is allowed.
  const peer = product(t, { overrides: { peerDependencies: { '@fixture/cli': '1.2.3' }, peerDependenciesMeta: { '@fixture/cli': { optional: true } } } });
  assert.deepEqual(await problemsOf(peer), []);
});

test('manifests: a CLI-only bare package depends on exactly its CLI; a bare core only matches its CLI', async t => {
  const cliOnly = { core: undefined };
  const exact = product(t, { entry: cliOnly, overrides: { exports: undefined, dependencies: { '@fixture/cli': '1.2.3' } } });
  assert.deepEqual(await problemsOf(exact), []);
  const ranged = product(t, { entry: cliOnly, overrides: { exports: undefined, dependencies: { '@fixture/cli': '~1.2.3' } } });
  assert.ok((await problemsOf(ranged)).some(problem => /dependencies\["@fixture\/cli"\] must be exactly 1\.2\.3/.test(problem)));
  const overridden = product(t, { entry: cliOnly, overrides: { exports: undefined, dependencies: { '@fixture/cli': '1.2.3' }, optionalDependencies: { '@fixture/cli': '1.2.2' } } });
  assert.ok((await problemsOf(overridden)).some(problem => /optionalDependencies must not list @fixture\/cli/.test(problem)));

  // plugfn's shape: the bare package is the core itself and adds the CLI's bin.
  const selfCore = product(t, { entry: { core: 'fixture' }, overrides: { dependencies: {} } });
  const { target, targets } = await bareTarget(selfCore);
  assert.deepEqual((await checkBareManifests({ root: selfCore, target, targets })).packages, [{ slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3', bins: ['fixture', 'fx'] }]);

  // Core only: no bin, no frontDoor.
  const coreOnly = product(t, { entry: { cli: undefined }, overrides: { bin: undefined, frontDoor: undefined } });
  assert.deepEqual(await problemsOf(coreOnly), []);
  const strayFrontDoor = product(t, { entry: { cli: undefined }, overrides: { bin: undefined } });
  assert.ok((await problemsOf(strayFrontDoor)).some(problem => /frontDoor applies only/.test(problem)));
});

test('registry: the core and CLI must already be on npm at the version', async t => {
  const packages = [
    { slug: 'fixture-core', name: '@fixture/core', version: '1.2.3', forbid: ['@fixture/cli'] },
    { slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3', bins: ['fixture', 'fx'] },
  ];
  const registry = 'https://registry.example.test/';
  const urls = [];
  const published = {
    'https://registry.example.test/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3' },
    'https://registry.example.test/@fixture%2fcli/1.2.3': { ...publishedCli, bin: { fixture: 'dist/cli.js', fx: './dist/cli.js' } },
    [CLI_TARBALL]: cliTarball(t),
  };
  const fetch = async (url, init) => {
    urls.push(url);
    return registryAnswering(published)(url, init);
  };
  await assertPublished(packages, { registry, fetch });
  assert.deepEqual(urls, Object.keys(published));
  // A published manifest naming a bin file its tarball lacks is refused.
  const hollow = { ...published, [CLI_TARBALL]: cliTarball(t, ['README.md']) };
  await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(hollow) }), error => error.code === 'not-published' && /has no dist\/cli\.js for its fixture bin/.test(error.message));
  // A link at the bin path is not a bin: npm does not install tar links.
  const linkDir = tempDir(t, 'bare-release-link-');
  mkdirSync(path.join(linkDir, 'package/dist'), { recursive: true });
  writeJson(path.join(linkDir, 'package/package.json'), { name: '@fixture/cli', version: '1.2.3' });
  writeFileSync(path.join(linkDir, 'package/real.js'), '\n');
  symlinkSync('../real.js', path.join(linkDir, 'package/dist/cli.js'));
  execFileSync('tar', ['-czf', path.join(linkDir, 'cli.tgz'), '-C', linkDir, 'package']);
  const linked = { ...published, [CLI_TARBALL]: readFileSync(path.join(linkDir, 'cli.tgz')) };
  await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(linked) }), /has no dist\/cli\.js for its fixture bin/);
  const coreWithCli = { ...published, 'https://registry.example.test/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3', optionalDependencies: { '@fixture/cli': '1.2.3' } } };
  await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(coreWithCli) }), /@fixture\/core@1\.2\.3 on npm depends on @fixture\/cli \(optionalDependencies\["@fixture\/cli"\]\)/);
  const noTarball = { ...published, [CLI_TARBALL]: undefined };
  await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(noTarball) }), error => error.code === 'registry-unavailable' && /tarball/.test(error.message));

  const onlyCore = registryAnswering({ 'https://registry.example.test/@fixture%2fcore/1.2.3': published['https://registry.example.test/@fixture%2fcore/1.2.3'] });
  await assert.rejects(assertPublished(packages, { registry, fetch: onlyCore }), error => error.code === 'not-published' && /release fixture-cli-v1\.2\.3 first/.test(error.message));
  await assert.rejects(assertPublished(packages, { registry, fetch: async () => new Response('', { status: 503 }) }), error => error.code === 'registry-unavailable' && /503/.test(error.message));
  await assert.rejects(assertPublished(packages, { registry, fetch: async () => { throw new Error('offline'); } }), error => error.code === 'registry-unavailable' && /offline/.test(error.message));
  const wrong = async () => new Response(JSON.stringify({ name: '@fixture/core', version: '1.2.2' }), { status: 200 });
  await assert.rejects(assertPublished(packages, { registry, fetch: wrong }), /returned @fixture\/core@1\.2\.2/);

  // The published CLI must have the bins the bare package runs, on one file.
  const cliUrl = 'https://registry.example.test/@fixture%2fcli/1.2.3';
  for (const bin of [undefined, { legacy: 'dist/cli.js' }, { fixture: 'dist/cli.js' }, { fixture: 'dist/cli.js', fx: 'dist/other.js' }]) {
    const answers = { ...published, [cliUrl]: { ...publishedCli, bin } };
    await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(answers) }), error => error.code === 'not-published' && /does not have the bins fixture, fx/.test(error.message));
  }
});

test('packed tarball: keeps the checked manifest fields and the shared shim', async t => {
  const root = product(t);
  const dir = path.join(root, 'bare');
  writeFileSync(path.join(dir, 'index.js'), 'export {};\n');
  const pack = () => path.join(root, JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: dir, encoding: 'utf8' }))[0].filename);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const tarball = pack();
  await checkPackedBare({ tarball, manifest });
  await assert.rejects(checkPackedBare({ tarball, manifest: { ...manifest, dependencies: { '@fixture/core': '1.2.2' } } }), /changed dependencies/);
  await assert.rejects(checkPackedBare({ tarball, manifest: { ...manifest, bin: { fixture: './bin/cli.mjs' } } }), /changed bin/);
  rmSync(path.join(dir, 'index.js'));
  await assert.rejects(checkPackedBare({ tarball: pack(), manifest }), /lacks \.\/index\.js, which import "fixture" resolves to/);
  writeFileSync(path.join(dir, 'index.js'), 'export {};\n');
  writeFileSync(path.join(dir, SHIM_FILE), `${readFileSync(SHIM_TEMPLATE, 'utf8')}// changed\n`);
  await assert.rejects(checkPackedBare({ tarball: pack(), manifest }), /differs from the shared shim template/);
});

test('tarball reader: regular files, links and long (pax) paths', t => {
  const dir = tempDir(t, 'bare-release-tar-');
  const long = `dist/${'nested-folder-name/'.repeat(8)}cli.js`;
  writeJson(path.join(dir, 'package.json'), { name: '@fixture/long', version: '1.0.0', files: ['dist'] });
  mkdirSync(path.dirname(path.join(dir, long)), { recursive: true });
  writeFileSync(path.join(dir, long), 'long\n');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: dir, encoding: 'utf8' }));
  const entries = readTarball(readFileSync(path.join(dir, packed.filename)));
  assert.ok(long.length > 100);
  assert.equal(entries.get(`package/${long}`)?.type, '0');
  assert.equal(entries.get(`package/${long}`).data.toString('utf8'), 'long\n');
  assert.equal(JSON.parse(entries.get('package/package.json').data.toString('utf8')).name, '@fixture/long');

  // A header whose checksum does not match is refused, as npm's tar reader refuses it.
  const raw = gunzipSync(readFileSync(path.join(dir, packed.filename)));
  raw[0] ^= 0x01;
  assert.throws(() => readTarball(gzipSync(raw)), /invalid tar header checksum/);
  // An entry that claims more bytes than the archive holds is refused.
  const whole = gunzipSync(readFileSync(path.join(dir, packed.filename)));
  const firstSize = Number.parseInt(whole.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
  const truncated = whole.subarray(0, 512 + firstSize - 1);
  assert.throws(() => readTarball(gzipSync(truncated)), /runs past the end/);
});

test('gate: a bare tag needs aligned manifests and published scoped packages; other tags pass through', async t => {
  const root = product(t);
  const answers = {
    'https://registry.npmjs.org/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3' },
    'https://registry.npmjs.org/@fixture%2fcli/1.2.3': publishedCli,
    [CLI_TARBALL]: cliTarball(t),
  };
  const result = await assertBareRelease('fixture-v1.2.3', { root, fetch: registryAnswering(answers) });
  assert.equal(result.bare, true);
  assert.equal(result.version, '1.2.3');
  await assert.rejects(assertBareRelease('fixture-v1.2.3', { root, fetch: registryAnswering({}) }), /not on npm yet/);
  const neverAsked = async () => assert.fail('a non-bare release must not reach the registry');
  assert.deepEqual(await assertBareRelease('fixture-core-v1.2.3', { root, fetch: neverAsked }), { bare: false });
  const drifted = product(t, { cliVersion: '1.2.4' });
  await assert.rejects(assertBareRelease('fixture-v1.2.3', { root: drifted, fetch: neverAsked }), /not 1\.2\.3/);

  const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, 'assert-bare-release.mjs'), 'fixture-core-v1.2.3', '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /not a bare package release/);
});

test('every bare entry of this checkout matches its core and CLI', async () => {
  const targets = await loadReleaseTargets({ root: repoRoot });
  for (const target of targets.filter(candidate => candidate.bare)) {
    await checkBareManifests({ root: repoRoot, target, targets });
  }
});

test('shim: imports only Node.js built-ins', () => {
  const source = readFileSync(SHIM_TEMPLATE, 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/);
  assert.doesNotMatch(source, /\brequire\(/);
});

/**
 * An installed bare package `fixture` (bins fixture and fx through the shim) at 1.2.3 under <root>/node_modules,
 * optionally with @fixture/cli installed beside it at `installedCli`.
 */
function installedProduct(t, { installedCli = '1.2.3' } = {}) {
  const root = tempDir(t, 'bare-shim-');
  const bare = path.join(root, 'node_modules/fixture');
  writeJson(path.join(bare, 'package.json'), { name: 'fixture', version: '1.2.3', type: 'module', bin: { fixture: './bin/cli.mjs', fx: './bin/cli.mjs' }, frontDoor: { cli: '@fixture/cli' } });
  mkdirSync(path.join(bare, 'bin'));
  cpSync(SHIM_TEMPLATE, path.join(bare, SHIM_FILE));
  if (installedCli) writeCli(path.join(root, 'node_modules/@fixture/cli'), installedCli, 'installed');
  return { root, shim: path.join(bare, SHIM_FILE) };
}

// A CLI whose bin prints where it ran from, its argv and PATH, and exits with the code its first argument names.
function writeCli(dir, version, origin) {
  writeJson(path.join(dir, 'package.json'), { name: '@fixture/cli', version, type: 'module', bin: { fixture: './cli.mjs', fx: './cli.mjs' } });
  writeFileSync(
    path.join(dir, 'cli.mjs'),
    `import { fileURLToPath } from 'node:url';\n` +
      `console.log(JSON.stringify({ origin: ${JSON.stringify(origin)}, version: ${JSON.stringify(version)}, main: process.argv[1] === fileURLToPath(import.meta.url), args: process.argv.slice(2), path: process.env.PATH }));\n` +
      `process.exitCode = Number(process.argv[2] ?? 0);\n`,
  );
}

const runShim = (shim, args, env = {}, cwd = undefined) => {
  const result = spawnSync(process.execPath, [shim, ...args], { cwd, encoding: 'utf8', env: { ...process.env, npm_execpath: '', ...env } });
  return { ...result, output: result.stdout.trim() ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : null };
};

/**
 * A stand-in npm-cli.js that records each call ({ args, cwd }). `npm exec` reports a PATH whose first .bin folder holds a
 * fetched CLI (none with `reportsBin: false`); `npm ls` prints the `listed` folders and exits 1, as for an imperfect tree.
 */
function fakeNpm(t, { fetchedCli, status = 0, reportsBin = true, listed = [] }) {
  const dir = tempDir(t, 'bare-shim-npm-');
  const cache = path.join(dir, 'cache');
  if (fetchedCli) writeCli(path.join(cache, 'node_modules/@fixture/cli'), fetchedCli, 'fetched');
  mkdirSync(path.join(cache, 'node_modules/.bin'), { recursive: true });
  const record = path.join(dir, 'calls.jsonl');
  const bin = JSON.stringify(path.join(cache, 'node_modules/.bin') + path.delimiter);
  writeFileSync(
    path.join(dir, 'npm-cli.js'),
    `const { appendFileSync } = require('node:fs');\n` +
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n` +
      `if (process.argv[2] === 'ls') { process.stdout.write(${JSON.stringify(listed.map(folder => `${folder}\n`).join(''))}); process.exitCode = 1; }\n` +
      `else { process.stdout.write((${reportsBin} ? ${bin} : '') + process.env.PATH + '\\n'); process.exitCode = ${status}; }\n`,
  );
  const calls = () => readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { npmCli: path.join(dir, 'npm-cli.js'), calls, args: () => calls()[0].args };
}

test('shim: runs the installed CLI at its version in this process, with arguments, aliases and exit code', t => {
  const { shim } = installedProduct(t);
  const run = runShim(shim, ['3', '--flag', 'value with spaces']);
  assert.equal(run.status, 3, run.stderr);
  assert.deepEqual({ ...run.output, path: undefined }, { origin: 'installed', version: '1.2.3', main: true, args: ['3', '--flag', 'value with spaces'], path: undefined });
  assert.equal(runShim(shim, ['0']).status, 0);
});

test('shim: fetches the CLI at exactly its version when no matching copy is installed', t => {
  const { shim } = installedProduct(t, { installedCli: '1.2.2' });
  const npm = fakeNpm(t, { fetchedCli: '1.2.3' });
  const run = runShim(shim, ['0', 'status'], { npm_execpath: npm.npmCli });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.origin, 'fetched');
  assert.deepEqual(run.output.args, ['0', 'status']);
  assert.equal(run.output.main, true);
  assert.equal(run.output.path.split(path.delimiter)[0], path.join(path.dirname(npm.npmCli), 'cache/node_modules/.bin'));
  assert.deepEqual(npm.args(), ['exec', '--yes', '--package=@fixture/cli@1.2.3', '--', 'node', '-p', 'process.env.PATH']);
});

test('shim: stops, without running another version, when npm reports no PATH reaching the CLI', t => {
  const { shim } = installedProduct(t, { installedCli: '1.2.2' });
  const npm = fakeNpm(t, { reportsBin: false });
  const run = runShim(shim, ['0'], { npm_execpath: npm.npmCli });
  assert.equal(run.status, 1);
  assert.equal(run.output, null);
  assert.match(run.stderr, /npm found @fixture\/cli@1\.2\.3 but no runnable fixture command for it/);
  assert.deepEqual(npm.calls().map(call => call.args[0]), ['exec']);
});

test('shim: a CLI bin that resolves outside its package is never run', t => {
  const { root, shim } = installedProduct(t, { installedCli: null });
  const outside = path.join(root, 'elsewhere');
  writeCli(outside, '1.2.4', 'outside');
  const cliDir = path.join(root, 'node_modules/@fixture/cli');
  writeJson(path.join(cliDir, 'package.json'), { name: '@fixture/cli', version: '1.2.3', type: 'module', bin: { fixture: './cli.mjs' } });
  symlinkSync(path.join(outside, 'cli.mjs'), path.join(cliDir, 'cli.mjs'));
  const npm = fakeNpm(t, {});
  const run = runShim(shim, ['0'], { npm_execpath: npm.npmCli });
  assert.equal(run.status, 1);
  assert.equal(run.output, null);
  assert.match(run.stderr, /no runnable fixture command/);
});

test('shim: says what failed when npm cannot fetch the CLI or the fetched copy has no matching bin', t => {
  const { shim } = installedProduct(t, { installedCli: null });
  const failing = fakeNpm(t, { status: 1 });
  const failed = runShim(shim, [], { npm_execpath: failing.npmCli });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /fixture: npm could not fetch @fixture\/cli@1\.2\.3\./);
  const wrongVersion = fakeNpm(t, { fetchedCli: '9.9.9' });
  const mismatch = runShim(shim, [], { npm_execpath: wrongVersion.npmCli });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /npm found @fixture\/cli@1\.2\.3 but no runnable fixture command for it/);

  const { root, shim: unnamed } = installedProduct(t);
  const manifest = path.join(root, 'node_modules/fixture/package.json');
  writeJson(manifest, { ...JSON.parse(readFileSync(manifest, 'utf8')), frontDoor: undefined });
  const noCli = runShim(unnamed, []);
  assert.equal(noCli.status, 1);
  assert.match(noCli.stderr, /names no CLI package in frontDoor\.cli/);
});

test('pack: a bare tarball is checked against the committed release entry, manifest and shim', t => {
  const root = product(t, { overrides: { scripts: { build: 'node -e 0', test: 'node -e 0' } } });
  writeFileSync(path.join(root, 'bare/index.js'), 'export {};\n');
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['pack-release-package.mjs', 'resolve-release-tag.mjs', 'owners.mjs', 'assert-bare-release.mjs', 'bare-cli-shim.mjs']) {
    cpSync(path.join(import.meta.dirname, file), path.join(root, 'scripts', file));
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  const pack = () => spawnSync(process.execPath, [path.join(root, 'scripts/pack-release-package.mjs'), 'fixture-v1.2.3'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });

  const clean = pack();
  assert.equal(clean.status, 0, clean.stderr);

  // As an install hook could: drop the bare fields from the working tree's release row and loosen the core pin.
  const releases = JSON.parse(readFileSync(path.join(root, 'release-packages.json'), 'utf8'));
  writeJson(path.join(root, 'release-packages.json'), releases.map(({ kind, core, cli, ...entry }) => entry));
  const manifestFile = path.join(root, 'bare/package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  writeJson(manifestFile, { ...manifest, dependencies: { '@fixture/core': '^1.2.0' } });
  const tampered = pack();
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /changed dependencies after the bare release gate checked them/);
});
