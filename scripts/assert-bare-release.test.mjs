import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BareReleaseError, SHIM_FILE, SHIM_TEMPLATE, assertBareRelease, assertPublished, checkBareManifests } from './assert-bare-release.mjs';
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
  return new Response(JSON.stringify(answer), { status: 200 });
};

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
      { slug: 'fixture-core', name: '@fixture/core', version: '1.2.3' },
      { slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3' },
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

  // plugfn's shape: the bare package is the core itself and adds the CLI's bin.
  const selfCore = product(t, { entry: { core: 'fixture' }, overrides: { dependencies: {} } });
  const { target, targets } = await bareTarget(selfCore);
  assert.deepEqual((await checkBareManifests({ root: selfCore, target, targets })).packages, [{ slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3' }]);

  // Core only: no bin, no frontDoor.
  const coreOnly = product(t, { entry: { cli: undefined }, overrides: { bin: undefined, frontDoor: undefined } });
  assert.deepEqual(await problemsOf(coreOnly), []);
  const strayFrontDoor = product(t, { entry: { cli: undefined }, overrides: { bin: undefined } });
  assert.ok((await problemsOf(strayFrontDoor)).some(problem => /frontDoor applies only/.test(problem)));
});

test('registry: the core and CLI must already be on npm at the version', async () => {
  const packages = [
    { slug: 'fixture-core', name: '@fixture/core', version: '1.2.3' },
    { slug: 'fixture-cli', name: '@fixture/cli', version: '1.2.3' },
  ];
  const registry = 'https://registry.example.test/';
  const urls = [];
  const published = {
    'https://registry.example.test/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3' },
    'https://registry.example.test/@fixture%2fcli/1.2.3': { name: '@fixture/cli', version: '1.2.3' },
  };
  const fetch = async (url, init) => {
    urls.push(url);
    return registryAnswering(published)(url, init);
  };
  await assertPublished(packages, { registry, fetch });
  assert.deepEqual(urls, Object.keys(published));

  const onlyCore = registryAnswering({ 'https://registry.example.test/@fixture%2fcore/1.2.3': published['https://registry.example.test/@fixture%2fcore/1.2.3'] });
  await assert.rejects(assertPublished(packages, { registry, fetch: onlyCore }), error => error.code === 'not-published' && /release fixture-cli-v1\.2\.3 first/.test(error.message));
  await assert.rejects(assertPublished(packages, { registry, fetch: async () => new Response('', { status: 503 }) }), error => error.code === 'registry-unavailable' && /503/.test(error.message));
  await assert.rejects(assertPublished(packages, { registry, fetch: async () => { throw new Error('offline'); } }), error => error.code === 'registry-unavailable' && /offline/.test(error.message));
  const wrong = async () => new Response(JSON.stringify({ name: '@fixture/core', version: '1.2.2' }), { status: 200 });
  await assert.rejects(assertPublished(packages, { registry, fetch: wrong }), /returned @fixture\/core@1\.2\.2/);
});

test('gate: a bare tag needs aligned manifests and published scoped packages; other tags pass through', async t => {
  const root = product(t);
  const answers = {
    'https://registry.npmjs.org/@fixture%2fcore/1.2.3': { name: '@fixture/core', version: '1.2.3' },
    'https://registry.npmjs.org/@fixture%2fcli/1.2.3': { name: '@fixture/cli', version: '1.2.3' },
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

const runShim = (shim, args, env = {}) => {
  const result = spawnSync(process.execPath, [shim, ...args], { encoding: 'utf8', env: { ...process.env, npm_execpath: '', ...env } });
  return { ...result, output: result.stdout.trim() ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : null };
};

/** A stand-in npm-cli.js that records its arguments and reports a PATH whose .bin folder holds a fetched CLI. */
function fakeNpm(t, { fetchedCli, status = 0 }) {
  const dir = tempDir(t, 'bare-shim-npm-');
  const cache = path.join(dir, 'cache');
  if (fetchedCli) writeCli(path.join(cache, 'node_modules/@fixture/cli'), fetchedCli, 'fetched');
  mkdirSync(path.join(cache, 'node_modules/.bin'), { recursive: true });
  const record = path.join(dir, 'args.json');
  writeFileSync(
    path.join(dir, 'npm-cli.js'),
    `const { writeFileSync } = require('node:fs');\n` +
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(${JSON.stringify(path.join(cache, 'node_modules/.bin') + path.delimiter)} + process.env.PATH + '\\n');\n` +
      `process.exitCode = ${status};\n`,
  );
  return { npmCli: path.join(dir, 'npm-cli.js'), args: () => JSON.parse(readFileSync(record, 'utf8')) };
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

test('shim: says what failed when npm cannot fetch the CLI or the fetched copy has no matching bin', t => {
  const { shim } = installedProduct(t, { installedCli: null });
  const failing = fakeNpm(t, { status: 1 });
  const failed = runShim(shim, [], { npm_execpath: failing.npmCli });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /fixture: npm could not fetch @fixture\/cli@1\.2\.3\./);
  const wrongVersion = fakeNpm(t, { fetchedCli: '9.9.9' });
  const mismatch = runShim(shim, [], { npm_execpath: wrongVersion.npmCli });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /npm fetched @fixture\/cli@1\.2\.3, but its fixture command was not found\./);

  const { root, shim: unnamed } = installedProduct(t);
  const manifest = path.join(root, 'node_modules/fixture/package.json');
  writeJson(manifest, { ...JSON.parse(readFileSync(manifest, 'utf8')), frontDoor: undefined });
  const noCli = runShim(unnamed, []);
  assert.equal(noCli.status, 1);
  assert.match(noCli.stderr, /names no CLI package in frontDoor\.cli/);
});
