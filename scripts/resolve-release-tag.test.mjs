import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReleaseTargetError, loadReleaseTargets, resolveReleaseTag } from './resolve-release-tag.mjs';


test('strict semver, target identity, private guard and channel safety', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'release-tag-contract-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'library'));
  await writeFile(path.join(fixture, 'release-packages.json'), JSON.stringify([{ slug: 'library', name: '@fixture/library', path: 'library' }]));
  const setManifest = version => writeFile(path.join(fixture, 'library/package.json'), JSON.stringify({ name: '@fixture/library', version }));
  const resolve = tag => resolveReleaseTag(tag, { root: fixture });
  for (const [version, channel] of [['1.2.3', 'latest'], ['1.2.3-experimental.0', 'experimental'], ['1.2.3-rc.1', 'rc'], ['1.2.3-beta.2+build.3', 'beta']]) {
    await setManifest(version);
    assert.equal((await resolve(`library-v${version}`)).distTag, channel);
  }
  for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-rc..1', '1.2.3-rc.01', '1.2.3+', '1.2.3-0', '1.2.3-x.1', '1.2.3-v1.0', '1.2.3-latest.1', '1.2.3-Experimental.1']) {
    await setManifest(version);
    await assert.rejects(resolve(`library-v${version}`));
  }
  await setManifest('1.2.3');
  await assert.rejects(resolve('library-v1.2.4'), /does not match/);
  await assert.rejects(resolve('unsupported-v1.2.3'), /No publishable/);
  await assert.rejects(resolve('python-library-v1.2.3'), /No publishable/);
  await assert.rejects(resolve('v1.2.3'), /Unsupported tag/);
  await writeFile(path.join(fixture, 'library/package.json'), JSON.stringify({ name: '@fixture/library', version: '1.2.3', private: true }));
  await assert.rejects(resolve('library-v1.2.3'), /private package/);
  await writeFile(path.join(fixture, 'library/package.json'), JSON.stringify({ name: '@fixture/wrong', version: '1.2.3' }));
  await assert.rejects(resolve('library-v1.2.3'), /expected/);
  await writeFile(path.join(fixture, 'library/package.json'), JSON.stringify({ name: '@fixture/library', version: '1.2.3-rc.1', publishConfig: { tag: 'latest' } }));
  await assert.rejects(resolve('library-v1.2.3-rc.1'), /conflicts/);
});

test('release-packages.next.json overlay adds targets and never repeats a base slug or name', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'release-tag-overlay-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const [dir, name] of [['library', '@fixture/library'], ['nextonly', '@fixture/nextonly']]) {
    await mkdir(path.join(fixture, dir));
    await writeFile(path.join(fixture, dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  const base = [{ slug: 'library', name: '@fixture/library', path: 'library' }];
  await writeFile(path.join(fixture, 'release-packages.json'), JSON.stringify(base));
  const overlay = entries => writeFile(path.join(fixture, 'release-packages.next.json'), JSON.stringify(entries));
  const resolve = tag => resolveReleaseTag(tag, { root: fixture });
  const rejectsWith = (promise, code, pattern) =>
    assert.rejects(promise, error => error instanceof ReleaseTargetError && error.code === code && pattern.test(error.message));

  // Without an overlay only the base file is read.
  assert.deepEqual((await loadReleaseTargets({ root: fixture })).map(target => target.slug), ['library']);
  await assert.rejects(resolve('nextonly-v1.0.0'), /No publishable/);

  await overlay([{ slug: 'nextonly', name: '@fixture/nextonly', path: 'nextonly' }]);
  assert.deepEqual(await resolve('nextonly-v1.0.0'), {
    tag: 'nextonly-v1.0.0', slug: 'nextonly', name: '@fixture/nextonly', version: '1.0.0', path: 'nextonly', distTag: 'latest',
  });
  assert.equal((await resolve('library-v1.0.0')).path, 'library');
  assert.deepEqual((await loadReleaseTargets({ root: fixture })).map(target => target.source), ['release-packages.json', 'release-packages.next.json']);

  await overlay([{ slug: 'library', name: '@fixture/nextonly', path: 'nextonly' }]);
  await rejectsWith(resolve('library-v1.0.0'), 'duplicate-slug', /"library" is listed in both release-packages\.json and release-packages\.next\.json/);
  await overlay([{ slug: 'nextonly', name: '@fixture/nextonly', path: 'nextonly' }, { slug: 'nextonly', name: '@fixture/other', path: 'nextonly' }]);
  await rejectsWith(resolve('nextonly-v1.0.0'), 'duplicate-slug', /more than once in release-packages\.next\.json/);
  await overlay([{ slug: 'nextonly', name: '@fixture/library', path: 'nextonly' }]);
  await rejectsWith(resolve('nextonly-v1.0.0'), 'duplicate-name', /both publish @fixture\/library/);
  await overlay([{ slug: 'nextonly', name: '@fixture/nextonly', path: '../outside' }]);
  await rejectsWith(resolve('nextonly-v1.0.0'), 'invalid-target-path', /release-packages\.next\.json/);
  await overlay([{ slug: 'nextonly', name: '@fixture/nextonly' }]);
  await rejectsWith(resolve('nextonly-v1.0.0'), 'invalid-target', /release-packages\.next\.json/);
  await overlay({ slug: 'nextonly' });
  await rejectsWith(resolve('library-v1.0.0'), 'malformed-release-file', /array/);
  await writeFile(path.join(fixture, 'release-packages.next.json'), '[');
  await rejectsWith(resolve('library-v1.0.0'), 'malformed-release-file', /invalid JSON/);
});
