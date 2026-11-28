import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BareReleaseError, SHIM_FILE, SHIM_TEMPLATE, assertBareRelease, assertPublished, checkBareManifests, checkPackedBare } from './assert-bare-release.mjs';
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

const publishedCli = { name: '@fixture/cli', version: '1.2.3', bin: { fixture: './dist/cli.js', fx: './dist/cli.js' } };

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
  await expectProblem({ overrides: { exports: { '.': { 'node-addons': null, import: './index.js' } } } }, /exports must have a "\." entry that an ESM import resolves/);
  // An array matching no condition lets the next condition try; a blocked entry in it blocks.
  assert.deepEqual(await problemsOf(product(t, { overrides: { exports: { '.': { 'module-sync': [{ browser: './browser.js' }], import: './index.js' } } } })), []);
  await expectProblem({ overrides: { exports: { '.': { 'module-sync': [{ browser: './browser.js' }, null], import: './index.js' } } } }, /exports must have a "\." entry that an ESM import resolves/);
  await expectProblem({ overrides: { exports: { '.': { import: [], default: './index.js' } } } }, /exports must have a "\." entry that an ESM import resolves/);
  // Node refuses targets with ".", "..", empty or node_modules segments, and an array with nothing that resolves.
  for (const exports of ['./dist/../index.js', './a//index.js', './node_modules/x/index.js', './%2e%2e/index.js', { '.': ['bad', null] }]) {
    await expectProblem({ overrides: { exports } }, /exports must have a "\." entry that an ESM import resolves/);
  }
  // Node keeps trying past null and invalid entries (checked against Node 22's resolver).
  for (const exports of [{ '.': ['index.js', './index.js'] }, { '.': [null, './index.js'] }]) assert.deepEqual(await problemsOf(product(t, { overrides: { exports } })), []);
  assert.deepEqual(await problemsOf(product(t, { overrides: { exports: { '.': { types: './index.d.ts', browser: { worker: './w.js' }, import: './index.js' } } } })), []);

  // Installing the core must not install the CLI.
  const coreDependsOnCli = product(t);
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', dependencies: { 'the-cli': 'NPM:@fixture/cli@1.2.3' } });
  assert.ok((await problemsOf(coreDependsOnCli)).some(problem => /its core @fixture\/core must not depend on its CLI \(dependencies\["the-cli"\]\)/.test(problem)));
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', peerDependencies: { '@fixture/cli': '1.2.3' } });
  assert.ok((await problemsOf(coreDependsOnCli)).some(problem => /must not depend on its CLI \(peerDependencies\["@fixture\/cli"\]\)/.test(problem)));
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', peerDependencies: { '@fixture/cli': '1.2.3' }, peerDependenciesMeta: { '@fixture/cli': { optional: true } } });
  assert.deepEqual(await problemsOf(coreDependsOnCli), []);
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

test('registry: the core and CLI must already be on npm at the version', async () => {
  const packages = [
    { slug: 'fixture-core', name: '@fixture/core', version: '1.2.3', forbid: ['@fixture/cli'] },
    { slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3', bins: ['fixture', 'fx'] },
  ];
  const registry = 'https://registry.example.test/';
  const urls = [];
  const published = {
    'https://registry.example.test/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3' },
    'https://registry.example.test/@fixture%2fcli/1.2.3': { ...publishedCli, bin: { fixture: 'dist/cli.js', fx: './dist/cli.js' } },
  };
  const fetch = async (url, init) => {
    urls.push(url);
    return registryAnswering(published)(url, init);
  };
  await assertPublished(packages, { registry, fetch });
  assert.deepEqual(urls, Object.keys(published));
  const coreWithCli = { ...published, 'https://registry.example.test/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3', optionalDependencies: { '@fixture/cli': '1.2.3' } } };
  await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(coreWithCli) }), /@fixture\/core@1\.2\.3 on npm depends on @fixture\/cli \(optionalDependencies\["@fixture\/cli"\]\)/);
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

test('gate: a bare tag needs aligned manifests and published scoped packages; other tags pass through', async t => {
  const root = product(t);
  const answers = {
    'https://registry.npmjs.org/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3' },
    'https://registry.npmjs.org/@fixture%2fcli/1.2.3': publishedCli,
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
 * A stand-in npm-cli.js that records its arguments and runs `npm exec ... -- <bin> <args>` as npm would: the fetched
 * CLI's bin, when `fetchedCli` names its version, with the arguments after the bin name; otherwise it exits `status`.
 */
function fakeNpm(t, { fetchedCli, status = 1 } = {}) {
  const dir = tempDir(t, 'bare-shim-npm-');
  const cliDir = path.join(dir, 'cache/node_modules/@fixture/cli');
  if (fetchedCli) writeCli(cliDir, fetchedCli, 'fetched');
  const record = path.join(dir, 'args.json');
  writeFileSync(
    path.join(dir, 'npm-cli.js'),
    `const { writeFileSync } = require('node:fs');\n` +
      `const { spawnSync } = require('node:child_process');\n` +
      `const args = process.argv.slice(2);\n` +
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));\n` +
      `if (${Boolean(fetchedCli)}) {\n` +
      `  const result = spawnSync(process.execPath, [${JSON.stringify(path.join(cliDir, 'cli.mjs'))}, ...args.slice(args.indexOf('--') + 2)], { stdio: 'inherit' });\n` +
      `  process.exitCode = result.status;\n` +
      `} else process.exitCode = ${status};\n`,
  );
  return { npmCli: path.join(dir, 'npm-cli.js'), args: () => JSON.parse(readFileSync(record, 'utf8')) };
}

test('shim: runs the installed CLI at its version with Node.js, with arguments, aliases and exit code', t => {
  const { root, shim } = installedProduct(t);
  const run = runShim(shim, ['3', '--flag', 'value with spaces']);
  assert.equal(run.status, 3, run.stderr);
  assert.deepEqual({ ...run.output, path: undefined }, { origin: 'installed', version: '1.2.3', main: true, args: ['3', '--flag', 'value with spaces'], path: undefined });
  assert.equal(runShim(shim, ['0']).status, 0);
  // fx is an alias: the same shim file, so the same CLI bin.
  assert.equal(runShim(path.join(root, 'node_modules/fixture', SHIM_FILE), ['0']).output.origin, 'installed');
});

test('shim: has npm fetch and run the CLI at exactly its version when no matching copy is installed', t => {
  const { shim } = installedProduct(t, { installedCli: '1.2.2' });
  const npm = fakeNpm(t, { fetchedCli: '1.2.3' });
  const run = runShim(shim, ['4', 'status'], { npm_execpath: npm.npmCli });
  assert.equal(run.status, 4, run.stderr);
  assert.equal(run.output.origin, 'fetched');
  assert.deepEqual(run.output.args, ['4', 'status']);
  assert.deepEqual(npm.args(), ['exec', '--yes', '--package=@fixture/cli@1.2.3', '--', 'fixture', '4', 'status']);
});

test('shim: passes npm\'s exit code through when npm cannot fetch or run the CLI', t => {
  const { shim } = installedProduct(t, { installedCli: null });
  const npm = fakeNpm(t, { status: 7 });
  assert.equal(runShim(shim, [], { npm_execpath: npm.npmCli }).status, 7);
});

test('shim: exits by the signal that ended the CLI', { skip: process.platform === 'win32' }, t => {
  const { root, shim } = installedProduct(t);
  writeFileSync(path.join(root, 'node_modules/@fixture/cli/cli.mjs'), `process.kill(process.pid, 'SIGTERM');\n`);
  const run = spawnSync(process.execPath, [shim], { encoding: 'utf8', env: { ...process.env, npm_execpath: '' } });
  assert.ok(run.signal === 'SIGTERM' || run.status === 143, `status ${run.status}, signal ${run.signal}`);
});

test('shim: a bin path written with backslashes resolves as npm resolves it', t => {
  const { root, shim } = installedProduct(t, { installedCli: null });
  const cliDir = path.join(root, 'node_modules/@fixture/cli');
  writeCli(cliDir, '1.2.3', 'installed');
  mkdirSync(path.join(cliDir, 'dist'));
  cpSync(path.join(cliDir, 'cli.mjs'), path.join(cliDir, 'dist/cli.mjs'));
  rmSync(path.join(cliDir, 'cli.mjs'));
  writeJson(path.join(cliDir, 'package.json'), { name: '@fixture/cli', version: '1.2.3', type: 'module', bin: { fixture: 'dist\\cli.mjs' } });
  const run = runShim(shim, ['0']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.origin, 'installed');
});

test('shim: an installed bin that resolves outside its package is never run; npm runs the CLI instead', t => {
  const { root, shim } = installedProduct(t, { installedCli: null });
  const outside = path.join(root, 'elsewhere');
  writeCli(outside, '1.2.4', 'outside');
  const cliDir = path.join(root, 'node_modules/@fixture/cli');
  writeJson(path.join(cliDir, 'package.json'), { name: '@fixture/cli', version: '1.2.3', type: 'module', bin: { fixture: './cli.mjs' } });
  symlinkSync(path.join(outside, 'cli.mjs'), path.join(cliDir, 'cli.mjs'));
  const npm = fakeNpm(t, { fetchedCli: '1.2.3' });
  const run = runShim(shim, ['0'], { npm_execpath: npm.npmCli });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.origin, 'fetched');
});

test('shim: stops instead of looping when npm runs the bare command again', t => {
  const { shim } = installedProduct(t, { installedCli: null });
  // An npm that resolves the command name back to the bare package's own bin.
  const dir = tempDir(t, 'bare-shim-loop-');
  writeFileSync(
    path.join(dir, 'npm-cli.js'),
    `const { spawnSync } = require('node:child_process');\n` +
      `const args = process.argv.slice(2);\n` +
      `const result = spawnSync(process.execPath, [${JSON.stringify(shim)}, ...args.slice(args.indexOf('--') + 2)], { stdio: 'inherit' });\n` +
      `process.exitCode = result.status;\n`,
  );
  const run = runShim(shim, ['0'], { npm_execpath: path.join(dir, 'npm-cli.js') });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /npm ran this command again instead of @fixture\/cli@1\.2\.3's fixture bin/);
});

test('shim: a SIGHUP sent to the shim reaches npm as SIGTERM, which npm relays to the CLI', { skip: process.platform === 'win32' }, async t => {
  const { shim } = installedProduct(t, { installedCli: null });
  const dir = tempDir(t, 'bare-shim-hup-');
  const record = path.join(dir, 'signal.txt');
  writeFileSync(
    path.join(dir, 'npm-cli.js'),
    `const { writeFileSync } = require('node:fs');\n` +
      `for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => { writeFileSync(${JSON.stringify(record)}, signal); process.exit(0); });\n` +
      `console.log('ready');\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const child = spawn(process.execPath, [shim], { env: { ...process.env, npm_execpath: path.join(dir, 'npm-cli.js') }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => child.stdout.once('data', resolve));
  child.kill('SIGHUP');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(readFileSync(record, 'utf8'), 'SIGTERM');
});

test('shim: refuses to run without a CLI named in frontDoor.cli', t => {
  const { root, shim } = installedProduct(t);
  const manifest = path.join(root, 'node_modules/fixture/package.json');
  writeJson(manifest, { ...JSON.parse(readFileSync(manifest, 'utf8')), frontDoor: undefined });
  const run = runShim(shim, []);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /names no CLI package in frontDoor\.cli/);
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
