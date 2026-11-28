import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BareReleaseError, FRONT_DOOR_TEST_TEMPLATE, SHIM_FILE, SHIM_TEMPLATE, TEMPLATE, assertBareRelease, assertPublished, checkBareManifests, checkPackedBare } from './assert-bare-release.mjs';
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
  writeJson(path.join(root, 'cli/package.json'), { name: '@fixture/cli', version: cliVersion, bin: { fixture: './dist/cli.js', fx: './dist/cli.js' }, frontDoorCli: { checksExpectedVersion: true } });
  writeJson(path.join(root, 'bare/package.json'), {
    name: 'fixture',
    version: '1.2.3',
    type: 'module',
    exports: TEMPLATE.exports,
    bin: { fixture: './bin/cli.mjs', fx: './bin/cli.mjs' },
    files: ['bin', 'index.js', 'index.d.ts'],
    frontDoor: { cli: '@fixture/cli' },
    scripts: { test: TEMPLATE.testScript },
    dependencies: { '@fixture/core': '1.2.3' },
    devDependencies: { '@fixture/cli': '1.2.3' },
    ...overrides,
  });
  mkdirSync(path.join(root, 'bare/bin'));
  mkdirSync(path.join(root, 'bare/test'));
  cpSync(FRONT_DOOR_TEST_TEMPLATE, path.join(root, 'bare', TEMPLATE.testFile));
  for (const [file, content] of Object.entries(TEMPLATE.reexportFiles)) writeFileSync(path.join(root, 'bare', file), content('@fixture/core'));
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

const publishedCli = { name: '@fixture/cli', version: '1.2.3', bin: { fixture: './dist/cli.js', fx: './dist/cli.js' }, frontDoorCli: { checksExpectedVersion: true } };

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
  await rejects({ core: 'fixture' }, /a bare package that is the core itself is not supported/);
  const plain = tempDir(t, 'bare-release-plain-');
  writeJson(path.join(plain, 'release-packages.json'), [{ slug: 'lib', path: 'lib', name: 'lib', cli: 'lib-cli' }]);
  await assert.rejects(loadReleaseTargets({ root: plain }), /apply only to "kind": "bare"/);
  const chained = product(t);
  const entries = JSON.parse(readFileSync(path.join(chained, 'release-packages.json'), 'utf8'));
  entries.push({ slug: 'other', path: 'bare', name: 'other', kind: 'bare', cli: 'fixture' });
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

test('manifests: anything but the template shape, or drift from the core and CLI, is refused', async t => {
  const expectProblem = async (options, pattern) => {
    const problems = await problemsOf(product(t, options));
    assert.ok(problems.some(problem => pattern.test(problem)), `expected ${pattern} in ${JSON.stringify(problems)}`);
  };
  await expectProblem({ coreVersion: '1.2.2' }, /core @fixture\/core is at 1\.2\.2, not 1\.2\.3/);
  await expectProblem({ cliVersion: '1.3.0' }, /cli @fixture\/cli is at 1\.3\.0, not 1\.2\.3/);
  // Dependencies: exactly the pinned core.
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '^1.2.3' } } }, /dependencies must be \{"@fixture\/core":"1\.2\.3"\}/);
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '1.2.3', '@fixture/cli': '1.2.3' } } }, /dependencies must be \{"@fixture\/core":"1\.2\.3"\}/);
  await expectProblem({ overrides: { dependencies: { '@fixture/core': '1.2.3', 'cli-alias': 'npm:@fixture/cli@1.2.3' } } }, /dependencies must be/);
  for (const field of ['optionalDependencies', 'peerDependencies']) {
    await expectProblem({ overrides: { [field]: { '@fixture/core': '1.2.2' } } }, new RegExp(`${field} must be nothing`));
  }
  // Module entry: exactly the template's exports, type module, no main or imports.
  for (const exports of [{ '.': './index.js' }, { '.': './index.js', types: './index.d.ts' }, { '.': { import: './index.js' } }, undefined]) {
    await expectProblem({ overrides: { exports } }, /exports must be \{"\.":\{"types":"\.\/index\.d\.ts","import":"\.\/index\.js","default":"\.\/index\.js"\}\}/);
  }
  await expectProblem({ overrides: { main: './bin/cli.mjs' } }, /main must be nothing \(the template resolves only through exports\)/);
  await expectProblem({ overrides: { type: 'commonjs' } }, /type must be "module"/);
  await expectProblem({ overrides: { imports: { '#x': './x.js' } } }, /imports must be nothing/);
  // Bins: exactly the template's path, named after the package, aliases of the CLI's own bin.
  await expectProblem({ overrides: { frontDoor: { cli: '@fixture/other' } } }, /frontDoor must be \{"cli":"@fixture\/cli"\}/);
  await expectProblem({ overrides: { bin: { fx: './bin/cli.mjs' } } }, /bin must map "fixture"/);
  await expectProblem({ overrides: { bin: { fixture: './bin/cli.mjs', fixturectl: './bin/cli.mjs' } } }, /"fixturectl" bin with the same file/);
  await expectProblem({ overrides: { bin: { fixture: 'bin/cli.mjs' } } }, /bin "fixture" must be "\.\/bin\/cli\.mjs"/);
  await expectProblem({ overrides: { files: ['index.js'] } }, /files must include bin\/cli\.mjs/);
  // The front-door test: the template's script and file, and the CLI as the only devDependency.
  await expectProblem({ overrides: { scripts: { test: 'node --test' } } }, /scripts\.test must be "node --test test\/front-door\.test\.mjs"/);
  await expectProblem({ overrides: { devDependencies: undefined } }, /devDependencies must be \{"@fixture\/cli":"1\.2\.3"\}/);
  await expectProblem({ overrides: { devDependencies: { '@fixture/cli': '1.2.3', vitest: '^3.0.0' } } }, /devDependencies must be/);
  const testEdited = product(t);
  writeFileSync(path.join(testEdited, 'bare', TEMPLATE.testFile), `${readFileSync(FRONT_DOOR_TEST_TEMPLATE, 'utf8')}// local change\n`);
  assert.ok((await problemsOf(testEdited)).some(problem => /differs from the shared front-door test template/.test(problem)));
  rmSync(path.join(testEdited, 'bare', TEMPLATE.testFile));
  assert.ok((await problemsOf(testEdited)).some(problem => /test\/front-door\.test\.mjs is missing/.test(problem)));

  const reexport = product(t);
  writeFileSync(path.join(reexport, 'bare/index.js'), "export * from '@fixture/core';\nexport const extra = 1;\n");
  assert.ok((await problemsOf(reexport)).some(problem => /index\.js must be exactly/.test(problem)));
  rmSync(path.join(reexport, 'bare/index.d.ts'));
  assert.ok((await problemsOf(reexport)).some(problem => /index\.d\.ts must be exactly/.test(problem)));

  const unchecked = product(t);
  writeJson(path.join(unchecked, 'cli/package.json'), { name: '@fixture/cli', version: '1.2.3', bin: { fixture: './dist/cli.js', fx: './dist/cli.js' } });
  assert.ok((await problemsOf(unchecked)).some(problem => /its CLI @fixture\/cli must check BARE_EXPECTED_CLI at startup/.test(problem)));

  const edited = product(t);
  writeFileSync(path.join(edited, 'bare', SHIM_FILE), `${readFileSync(SHIM_TEMPLATE, 'utf8')}// local change\n`);
  assert.ok((await problemsOf(edited)).some(problem => /differs from the shared shim template/.test(problem)));
  const missing = product(t);
  rmSync(path.join(missing, 'bare', SHIM_FILE));
  assert.ok((await problemsOf(missing)).some(problem => /bin\/cli\.mjs is missing/.test(problem)));

  // Installing the core must not install the CLI.
  const coreDependsOnCli = product(t);
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', dependencies: { 'the-cli': 'NPM:@fixture/cli@1.2.3' } });
  assert.ok((await problemsOf(coreDependsOnCli)).some(problem => /its core @fixture\/core must not depend on its CLI \(dependencies\["the-cli"\]\)/.test(problem)));
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', peerDependencies: { '@fixture/cli': '1.2.3' } });
  assert.ok((await problemsOf(coreDependsOnCli)).some(problem => /must not depend on its CLI \(peerDependencies\["@fixture\/cli"\]\)/.test(problem)));
  writeJson(path.join(coreDependsOnCli, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', peerDependencies: { '@fixture/cli': '1.2.3' }, peerDependenciesMeta: { '@fixture/cli': { optional: true } } });
  assert.deepEqual(await problemsOf(coreDependsOnCli), []);
});

test('manifests: a CLI-only bare package has no module entry and depends on exactly its CLI', async t => {
  const cliOnly = { core: undefined };
  const shape = { exports: undefined, files: ['bin'], dependencies: { '@fixture/cli': '1.2.3' }, devDependencies: undefined };
  assert.deepEqual(await problemsOf(product(t, { entry: cliOnly, overrides: shape })), []);
  const ranged = await problemsOf(product(t, { entry: cliOnly, overrides: { ...shape, dependencies: { '@fixture/cli': '~1.2.3' } } }));
  assert.ok(ranged.some(problem => /dependencies must be \{"@fixture\/cli":"1\.2\.3"\}/.test(problem)));
  const withExports = await problemsOf(product(t, { entry: cliOnly, overrides: { ...shape, exports: TEMPLATE.exports } }));
  assert.ok(withExports.some(problem => /exports must be nothing \(a CLI-only bare package exports no modules\)/.test(problem)));
  const withMain = await problemsOf(product(t, { entry: cliOnly, overrides: { ...shape, main: './bin/cli.mjs' } }));
  assert.ok(withMain.some(problem => /main must be nothing/.test(problem)));
  const overridden = await problemsOf(product(t, { entry: cliOnly, overrides: { ...shape, optionalDependencies: { '@fixture/cli': '1.2.2' } } }));
  assert.ok(overridden.some(problem => /optionalDependencies must be nothing/.test(problem)));
});

test('manifests: a core-only bare package re-exports its core and has no bin', async t => {
  const coreOnly = { entry: { cli: undefined }, overrides: { bin: undefined, frontDoor: undefined, devDependencies: undefined, files: ['index.js', 'index.d.ts'] } };
  assert.deepEqual(await problemsOf(product(t, coreOnly)), []);
  const strayFrontDoor = product(t, { entry: { cli: undefined }, overrides: { bin: undefined, devDependencies: undefined } });
  assert.ok((await problemsOf(strayFrontDoor)).some(problem => /frontDoor applies only/.test(problem)));
  const strayBin = product(t, { entry: { cli: undefined }, overrides: { frontDoor: undefined, devDependencies: undefined } });
  assert.ok((await problemsOf(strayBin)).some(problem => /bin applies only/.test(problem)));
  const strayDev = product(t, { ...coreOnly, overrides: { ...coreOnly.overrides, devDependencies: { '@fixture/cli': '1.2.3' } } });
  assert.ok((await problemsOf(strayDev)).some(problem => /devDependencies must be nothing/.test(problem)));
});

test('front-door test template: passes against an importable core and a CLI at the version, fails otherwise', t => {
  const root = tempDir(t, 'bare-front-door-');
  const bare = path.join(root, 'node_modules/fixture');
  writeJson(path.join(bare, 'package.json'), { name: 'fixture', version: '1.2.3', type: 'module', exports: TEMPLATE.exports, bin: { fixture: './bin/cli.mjs' }, frontDoor: { cli: '@fixture/cli' }, dependencies: { '@fixture/core': '1.2.3' } });
  for (const [file, content] of Object.entries(TEMPLATE.reexportFiles)) writeFileSync(path.join(bare, file), content('@fixture/core'));
  mkdirSync(path.join(bare, 'bin'));
  cpSync(SHIM_TEMPLATE, path.join(bare, SHIM_FILE));
  mkdirSync(path.join(bare, 'test'));
  cpSync(FRONT_DOOR_TEST_TEMPLATE, path.join(bare, TEMPLATE.testFile));
  const core = path.join(root, 'node_modules/@fixture/core');
  const writeCore = exports => {
    writeJson(path.join(core, 'package.json'), { name: '@fixture/core', version: '1.2.3', type: 'module', exports });
    writeFileSync(path.join(core, 'index.js'), 'export const answer = 42;\nexport function ask() { return answer; }\n');
    writeFileSync(path.join(core, 'index.cjs'), 'exports.answer = 42;\n');
  };
  // A CLI that prints its version for --version.
  const cli = path.join(root, 'node_modules/@fixture/cli');
  const writeVersionCli = version => {
    writeJson(path.join(cli, 'package.json'), { name: '@fixture/cli', version, type: 'module', bin: { fixture: './cli.mjs' } });
    writeFileSync(path.join(cli, 'cli.mjs'), `if (process.argv.includes('--version')) console.log(${JSON.stringify(version)});\n`);
  };
  // NODE_TEST_CONTEXT, which this runner sets, would make the inner node --test report to it instead of exiting non-zero.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = () => spawnSync(process.execPath, ['--test', TEMPLATE.testFile], { cwd: bare, encoding: 'utf8', env: { ...env, npm_execpath: '' } });
  writeCore({ '.': './index.js' });
  writeVersionCli('1.2.3');
  const passing = run();
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  // A core that only a require can load.
  writeCore({ '.': { require: './index.cjs' } });
  assert.notEqual(run().status, 0);
  writeCore({ '.': './index.js' });
  // No CLI installed at the version: even with an npm that would supply it, the bin fails.
  writeVersionCli('1.2.2');
  assert.notEqual(run().status, 0);
  const npm = fakeNpm(t, { fetchedCli: '1.2.3' });
  const withNpm = spawnSync(process.execPath, ['--test', TEMPLATE.testFile], { cwd: bare, encoding: 'utf8', env: { ...env, npm_execpath: npm.npmCli } });
  assert.notEqual(withNpm.status, 0);
  assert.throws(() => npm.args(), /ENOENT/);
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

  // The published CLI must declare that it checks BARE_EXPECTED_CLI, as the checkout does.
  const undeclared = { ...published, 'https://registry.example.test/@fixture%2fcli/1.2.3': { ...publishedCli, frontDoorCli: undefined } };
  await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(undeclared) }), /does not declare that it checks BARE_EXPECTED_CLI/);

  // The published CLI must have the bins the bare package runs, on one file.
  const cliUrl = 'https://registry.example.test/@fixture%2fcli/1.2.3';
  for (const bin of [undefined, { legacy: 'dist/cli.js' }, { fixture: 'dist/cli.js' }, { fixture: 'dist/cli.js', fx: 'dist/other.js' }]) {
    const answers = { ...published, [cliUrl]: { ...publishedCli, bin } };
    await assert.rejects(assertPublished(packages, { registry, fetch: registryAnswering(answers) }), error => error.code === 'not-published' && /does not have the bins fixture, fx/.test(error.message));
  }
});

test('packed tarball: keeps the checked manifest fields, template files and the shared shim', async t => {
  const root = product(t);
  const dir = path.join(root, 'bare');
  const pack = () => path.join(root, JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: dir, encoding: 'utf8' }))[0].filename);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const reexport = { kind: 'reexport', core: '@fixture/core' };
  const tarball = pack();
  await checkPackedBare({ tarball, manifest, ...reexport });
  for (const [field, value] of [['dependencies', { '@fixture/core': '1.2.2' }], ['type', 'commonjs'], ['imports', { '#x': './x.js' }], ['main', './bin/cli.mjs'], ['bundleDependencies', true], ['bundledDependencies', ['@fixture/core']]]) {
    await assert.rejects(checkPackedBare({ tarball, manifest: { ...manifest, [field]: value }, ...reexport }), new RegExp(`changed ${field}`));
  }
  await assert.rejects(checkPackedBare({ tarball, manifest: { ...manifest, bin: { fixture: './bin/cli.mjs' } }, ...reexport }), /changed bin/);
  writeFileSync(path.join(dir, 'index.js'), 'export {};\n');
  await assert.rejects(checkPackedBare({ tarball: pack(), manifest, ...reexport }), /has no index\.js re-exporting @fixture\/core/);
  writeFileSync(path.join(dir, 'index.js'), TEMPLATE.reexportFiles['index.js']('@fixture/core'));
  writeFileSync(path.join(dir, SHIM_FILE), `${readFileSync(SHIM_TEMPLATE, 'utf8')}// changed\n`);
  await assert.rejects(checkPackedBare({ tarball: pack(), manifest, ...reexport }), /differs from the shared shim template/);
  cpSync(SHIM_TEMPLATE, path.join(dir, SHIM_FILE));

  // CLI-only: no file Node's legacy resolution would import.
  const cliOnlyManifest = { ...manifest, exports: undefined, files: ['bin', 'index.js'] };
  writeJson(path.join(dir, 'package.json'), cliOnlyManifest);
  await assert.rejects(checkPackedBare({ tarball: pack(), manifest: cliOnlyManifest, kind: 'cli-only' }), /is CLI-only but ships index\.js/);
  const cleanCliOnly = { ...cliOnlyManifest, files: ['bin'] };
  writeJson(path.join(dir, 'package.json'), cleanCliOnly);
  await checkPackedBare({ tarball: pack(), manifest: cleanCliOnly, kind: 'cli-only' });
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

// A CLI whose bin checks BARE_EXPECTED_CLI as the README describes, then prints where it ran from, its argv and PATH,
// and exits with the code its first argument names.
function writeCli(dir, version, origin) {
  writeJson(path.join(dir, 'package.json'), { name: '@fixture/cli', version, type: 'module', bin: { fixture: './cli.mjs', fx: './cli.mjs' }, frontDoorCli: { checksExpectedVersion: true } });
  writeFileSync(
    path.join(dir, 'cli.mjs'),
    `import { fileURLToPath } from 'node:url';\n` +
      `const expected = process.env.BARE_EXPECTED_CLI;\n` +
      `if (expected?.startsWith('@fixture/cli@')) {\n` +
      `  if (expected !== '@fixture/cli@${version}') { console.error(\`expected @fixture/cli \${expected.slice(13)}, found ${version}; run npx \${expected}\`); process.exit(1); }\n` +
      `  delete process.env.BARE_EXPECTED_CLI;\n` +
      `}\n` +
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

test('shim: a CLI npm reaches at another version (a nested copy npm reused) refuses to run', t => {
  // npm reused a nested 1.2.3 but the bin name on its PATH is the project's 1.2.2.
  const { shim } = installedProduct(t, { installedCli: '1.2.2' });
  const npm = fakeNpm(t, { fetchedCli: '1.2.2' });
  const run = runShim(shim, ['0'], { npm_execpath: npm.npmCli });
  assert.equal(run.status, 1);
  assert.equal(run.output, null);
  assert.match(run.stderr, /expected @fixture\/cli 1\.2\.3, found 1\.2\.2; run npx @fixture\/cli@1\.2\.3/);
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

test('shim: one Ctrl+C to the process group reaches the CLI once, and the shim exits as the CLI did', { skip: process.platform === 'win32' }, async t => {
  const { root, shim } = installedProduct(t);
  const record = path.join(root, 'sigint.log');
  writeFileSync(
    path.join(root, 'node_modules/@fixture/cli/cli.mjs'),
    `import { appendFileSync } from 'node:fs';\n` +
      `process.on('SIGINT', () => { appendFileSync(${JSON.stringify(record)}, 'SIGINT\\n'); setTimeout(() => process.exit(5), 300); });\n` +
      `console.log('ready');\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  // Its own process group, as a terminal's foreground job.
  const child = spawn(process.execPath, [shim], { detached: true, env: { ...process.env, npm_execpath: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => child.stdout.once('data', resolve));
  process.kill(-child.pid, 'SIGINT');
  const [code] = await new Promise(resolve => child.once('exit', (...result) => resolve(result)));
  assert.equal(readFileSync(record, 'utf8'), 'SIGINT\n');
  assert.equal(code, 5);
});

test('shim: a SIGTERM or SIGHUP sent to the shim alone reaches the CLI as SIGTERM', { skip: process.platform === 'win32' }, async t => {
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    const { root, shim } = installedProduct(t);
    const record = path.join(root, 'signal.log');
    writeFileSync(
      path.join(root, 'node_modules/@fixture/cli/cli.mjs'),
      `import { writeFileSync } from 'node:fs';\n` +
        `for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(name, () => { writeFileSync(${JSON.stringify(record)}, name); process.exit(0); });\n` +
        `console.log('ready');\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    const child = spawn(process.execPath, [shim], { env: { ...process.env, npm_execpath: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(resolve => child.stdout.once('data', resolve));
    child.kill(signal);
    await new Promise(resolve => child.once('exit', resolve));
    assert.equal(readFileSync(record, 'utf8'), 'SIGTERM', signal);
  }
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

test('shim: with BARE_CLI_NO_NPM=1 it never falls back to npm', t => {
  const { shim } = installedProduct(t, { installedCli: '1.2.2' });
  const npm = fakeNpm(t, { fetchedCli: '1.2.3' });
  const run = runShim(shim, ['0'], { npm_execpath: npm.npmCli, BARE_CLI_NO_NPM: '1' });
  assert.equal(run.status, 1);
  assert.equal(run.output, null);
  assert.match(run.stderr, /@fixture\/cli@1\.2\.3 is not installed here, and BARE_CLI_NO_NPM=1 forbids fetching it with npm/);
  assert.throws(() => npm.args(), /ENOENT/);
});

test('shim: refuses to run without a CLI named in frontDoor.cli', t => {
  const { root, shim } = installedProduct(t);
  const manifest = path.join(root, 'node_modules/fixture/package.json');
  writeJson(manifest, { ...JSON.parse(readFileSync(manifest, 'utf8')), frontDoor: undefined });
  const run = runShim(shim, []);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /names no CLI package in frontDoor\.cli/);
});

test('pack: a bare release runs the committed front-door test and checks the tarball against the commit', t => {
  // The test script is replaced, as an install hook could; the packer still runs the front-door test directly.
  const root = product(t, { overrides: { scripts: { build: 'node -e 0', test: 'node -e 0' } } });
  // The pinned core and CLI, as publish-tag.yml's install puts them.
  const installed = path.join(root, 'bare/node_modules/@fixture');
  const writeCore = exports => {
    writeJson(path.join(installed, 'core/package.json'), { name: '@fixture/core', version: '1.2.3', type: 'module', exports });
    writeFileSync(path.join(installed, 'core/index.js'), 'export const answer = 42;\n');
    writeFileSync(path.join(installed, 'core/index.cjs'), 'exports.answer = 42;\n');
  };
  writeCore({ '.': './index.js' });
  writeJson(path.join(installed, 'cli/package.json'), { name: '@fixture/cli', version: '1.2.3', type: 'module', bin: { fixture: './cli.mjs', fx: './cli.mjs' } });
  writeFileSync(path.join(installed, 'cli/cli.mjs'), "if (process.argv.includes('--version')) console.log('1.2.3');\n");
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['pack-release-package.mjs', 'resolve-release-tag.mjs', 'owners.mjs', 'assert-bare-release.mjs', 'bare-cli-shim.mjs', 'bare-front-door-test.mjs']) {
    cpSync(path.join(import.meta.dirname, file), path.join(root, 'scripts', file));
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const pack = () => spawnSync(process.execPath, [path.join(root, 'scripts/pack-release-package.mjs'), 'fixture-v1.2.3'], { cwd: root, encoding: 'utf8', env: { ...env, GITHUB_OUTPUT: '' } });

  const clean = pack();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);

  // A pinned core that ESM cannot import fails the release, though the test script was replaced.
  writeCore({ '.': { require: './index.cjs' } });
  assert.notEqual(pack().status, 0);
  writeCore({ '.': './index.js' });
  // A working-tree front-door test or manifest changed after the commit (as a hook could) does not replace the
  // committed ones for the run, and is restored afterwards.
  const testFile = path.join(root, 'bare', TEMPLATE.testFile);
  const hollowTest = "import test from 'node:test';\ntest('nothing', () => {});\n";
  writeFileSync(testFile, hollowTest);
  const manifestPath = path.join(root, 'bare/package.json');
  const committedManifest = readFileSync(manifestPath, 'utf8');
  writeJson(manifestPath, { ...JSON.parse(committedManifest), exports: undefined });
  writeCore({ '.': { require: './index.cjs' } });
  assert.notEqual(pack().status, 0);
  assert.equal(readFileSync(testFile, 'utf8'), hollowTest);
  writeFileSync(manifestPath, committedManifest);
  cpSync(FRONT_DOOR_TEST_TEMPLATE, testFile);
  writeCore({ '.': './index.js' });

  // Staging that fails part-way (index.js is a folder) still restores the working files it replaced.
  const workingManifest = `${committedManifest.trimEnd()}\n\n`;
  writeFileSync(manifestPath, workingManifest);
  rmSync(path.join(root, 'bare/index.js'));
  mkdirSync(path.join(root, 'bare/index.js'));
  assert.notEqual(pack().status, 0);
  assert.equal(readFileSync(manifestPath, 'utf8'), workingManifest);
  rmSync(path.join(root, 'bare/index.js'), { recursive: true });
  writeFileSync(path.join(root, 'bare/index.js'), TEMPLATE.reexportFiles['index.js']('@fixture/core'));
  writeFileSync(manifestPath, committedManifest);

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
