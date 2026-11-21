import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReleaseOwnerError, assertReleaseOwner, parseGateArgs, releaseOfTag, releaseRepoKind } from './assert-release-owner.mjs';

const PUBLIC_REPO = '21nCo/superfunctions';
const NEXT_REPO = '21nCo/super-functions.next';
const script = path.join(import.meta.dirname, 'assert-release-owner.mjs');

const publicManifest = (extra = {}) => ({
  version: 1,
  paths: { datafn: 'public' },
  rootFiles: { public: ['package.json'], generated: ['package-lock.json'] },
  releases: { 'datafn-core': 'public', ...extra.releases },
  python: { datafn: 'public', ...extra.python },
});
const nextManifest = (extra = {}) => ({
  version: 1,
  paths: { docsfn: 'next' },
  releases: { 'docsfn-core': 'next', ...extra.releases },
  python: { docsfn: 'next', ...extra.python },
});

/** A checkout with the given manifests; `next: null` is a public checkout without the next manifest. */
function checkout(t, { pub = publicManifest(), next = nextManifest() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'superfunctions.owners.json'), JSON.stringify(pub));
  if (next) writeFileSync(path.join(root, 'superfunctions.owners.next.json'), JSON.stringify(next));
  return root;
}

const refuses = (fn, code, ...fragments) =>
  assert.throws(fn, error => {
    assert.ok(error instanceof ReleaseOwnerError, `expected ReleaseOwnerError, got ${error}`);
    assert.equal(error.code, code, error.message);
    for (const fragment of fragments) assert.ok(error.message.includes(fragment), `${JSON.stringify(error.message)} lacks ${JSON.stringify(fragment)}`);
    return true;
  });

test('an owned slug or Python project passes in its own repository', t => {
  const withNext = checkout(t);
  assert.deepEqual(assertReleaseOwner({ kind: 'npm', tag: 'docsfn-core-v1.2.3', repository: NEXT_REPO, root: withNext }), {
    owner: 'next',
    name: 'docsfn-core',
    repository: NEXT_REPO,
    manifest: 'superfunctions.owners.next.json',
  });
  // GitHub repository names are case-insensitive.
  assert.equal(assertReleaseOwner({ kind: 'npm', tag: 'docsfn-core-v1.2.3-beta.1', repository: NEXT_REPO.toUpperCase(), root: withNext }).repository, NEXT_REPO);
  const publicOnly = checkout(t, { next: null });
  assert.equal(assertReleaseOwner({ kind: 'npm', tag: 'datafn-core-v1.2.3', repository: PUBLIC_REPO, root: publicOnly }).owner, 'public');
  // Python projects match by PEP 503 canonical name, as in python_release.py and the manifests.
  assert.equal(assertReleaseOwner({ kind: 'python', tag: 'python-datafn-v0.2.0rc1', repository: PUBLIC_REPO, root: publicOnly }).name, 'datafn');
  assert.equal(assertReleaseOwner({ kind: 'python', tag: 'python-docsfn-v1.0', repository: NEXT_REPO, root: withNext }).owner, 'next');
});

test("a release owned by the other repository is refused, naming the owning repository", t => {
  const root = checkout(t);
  refuses(
    () => assertReleaseOwner({ kind: 'npm', tag: 'datafn-core-v1.2.3', repository: NEXT_REPO, root }),
    'wrong-repository',
    `from ${NEXT_REPO}`,
    `owned by public (${PUBLIC_REPO}) in superfunctions.owners.json`,
    `Push the tag to ${PUBLIC_REPO}`,
  );
  refuses(
    () => assertReleaseOwner({ kind: 'npm', tag: 'docsfn-core-v1.2.3', repository: PUBLIC_REPO, root }),
    'wrong-repository',
    `owned by next (${NEXT_REPO}) in superfunctions.owners.next.json`,
  );
  refuses(
    () => assertReleaseOwner({ kind: 'python', tag: 'python-datafn-v1.0', repository: NEXT_REPO, root }),
    'wrong-repository',
    `Python project "datafn" is owned by public (${PUBLIC_REPO})`,
  );
  refuses(() => assertReleaseOwner({ kind: 'python', tag: 'python-docsfn-v1.0', repository: PUBLIC_REPO, root }), 'wrong-repository', `owned by next (${NEXT_REPO})`);
});

test('an unknown slug or project is refused in both repositories', t => {
  const root = checkout(t);
  refuses(
    () => assertReleaseOwner({ kind: 'npm', tag: 'ghostfn-core-v1.0.0', repository: PUBLIC_REPO, root }),
    'unlisted',
    'release "ghostfn-core" is not listed in superfunctions.owners.json or superfunctions.owners.next.json',
    'no repository owns it',
  );
  refuses(() => assertReleaseOwner({ kind: 'python', tag: 'python-ghostfn-v1.0', repository: NEXT_REPO, root }), 'unlisted', 'Python project "ghostfn"');
  // A public checkout has no next manifest: a next-owned slug is refused as outside public's allow-list, pointing at next.
  const publicOnly = checkout(t, { next: null });
  for (const [kind, tag] of [['npm', 'docsfn-core-v1.0.0'], ['python', 'python-docsfn-v1.0']]) {
    assert.throws(
      () => assertReleaseOwner({ kind, tag, repository: PUBLIC_REPO, root: publicOnly }),
      error =>
        error.code === 'unlisted' &&
        error.message.includes('is not listed in superfunctions.owners.json, the public allow-list') &&
        error.message.includes(`if next (${NEXT_REPO}) owns it, push the tag there`) &&
        !error.message.includes('no repository owns it'),
    );
  }
});

test('a slug or project listed in both manifests is refused, naming both repositories', t => {
  const both = checkout(t, { next: nextManifest({ releases: { 'datafn-core': 'next' } }) });
  for (const repository of [PUBLIC_REPO, NEXT_REPO]) {
    refuses(
      () => assertReleaseOwner({ kind: 'npm', tag: 'datafn-core-v1.0.0', repository, root: both }),
      'duplicate-owner',
      'release "datafn-core" is listed in both superfunctions.owners.json and superfunctions.owners.next.json',
      `public (${PUBLIC_REPO}) and next (${NEXT_REPO})`,
    );
  }
  const pythonBoth = checkout(t, { next: nextManifest({ python: { DataFn: 'next' } }) });
  refuses(() => assertReleaseOwner({ kind: 'python', tag: 'python-datafn-v1.0', repository: PUBLIC_REPO, root: pythonBoth }), 'duplicate-owner', 'Python project "DataFn"');
  // A conflict elsewhere in the manifests still refuses every release, but as an invalid manifest.
  refuses(() => assertReleaseOwner({ kind: 'npm', tag: 'docsfn-core-v1.0.0', repository: NEXT_REPO, root: both }), 'invalid-manifest', 'ownership manifests are invalid');
});

test('a repository other than the two publishers is refused before any manifest is read', t => {
  const root = checkout(t);
  for (const repository of ['someone/superfunctions', '21nCo/superfunctions-fork', '', undefined]) {
    refuses(() => assertReleaseOwner({ kind: 'npm', tag: 'datafn-core-v1.0.0', repository, root }), 'unknown-repository', `public (${PUBLIC_REPO}) and next (${NEXT_REPO})`);
  }
  assert.equal(releaseRepoKind('21nco/SuperFunctions'), 'public');
});

test('tags are split the way the release resolvers split them', () => {
  assert.deepEqual(releaseOfTag('npm', 'authfn-api-keys-v0.1.0-rc.1'), { kind: 'npm', name: 'authfn-api-keys' });
  assert.deepEqual(releaseOfTag('python', 'python-superfunctions-core-v1.0.0'), { kind: 'python', name: 'superfunctions-core' });
  assert.deepEqual(releaseOfTag('python', 'python-a-very-v-name-v2.0'), { kind: 'python', name: 'a-very-v-name' });
  for (const [kind, tag] of [['npm', 'datafn-core'], ['npm', 'refs/heads/dev'], ['python', 'python-v1.0'], ['python', 'datafn-v1.0'], ['python', 'python-datafn-v'], ['wheel', 'x-v1.0.0']]) {
    assert.throws(() => releaseOfTag(kind, tag), error => error instanceof ReleaseOwnerError && error.code === 'invalid-tag', `${kind} ${tag}`);
  }
});

test('the command reads GITHUB_REPOSITORY and exits non-zero with the refusal on stderr', () => {
  // The command reads this checkout's manifests, where datafn-core is public-owned.
  const run = (repository, ...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: repository } });
  const owned = run(PUBLIC_REPO, 'npm', 'datafn-core-v1.0.0');
  assert.equal(owned.status, 0, owned.stderr);
  assert.match(owned.stdout, /publishing from 21nCo\/superfunctions is allowed/);
  const wrong = run(NEXT_REPO, 'npm', 'datafn-core-v1.0.0');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /owned by public \(21nCo\/superfunctions\)/);
  assert.equal(run(PUBLIC_REPO, 'wheel', 'datafn-core-v1.0.0').status, 1);
  assert.equal(run(PUBLIC_REPO, 'npm').status, 1);
  assert.equal(run(PUBLIC_REPO, 'npm', 'datafn-core-v1.0.0', '--root').status, 1);
});

test('--root selects the checkout whose manifests decide ownership', t => {
  const root = checkout(t, { pub: publicManifest({ releases: { 'datafn-core': undefined } }), next: nextManifest({ releases: { 'datafn-core': 'next' } }) });
  const result = spawnSync(process.execPath, [script, 'npm', 'datafn-core-v1.0.0', '--root', root], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: PUBLIC_REPO } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owned by next \(21nCo\/super-functions\.next\) in superfunctions\.owners\.next\.json/);
  assert.deepEqual(parseGateArgs(['npm', '--root', root, 'x-v1.0.0']), { positionals: ['npm', 'x-v1.0.0'], root });
  assert.throws(() => parseGateArgs(['--root', 'a', '--root', 'b']), /--root needs one directory/);
});

test('the command still runs the gate when reached through a symlink', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-owner-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'assert-release-owner.mjs');
  symlinkSync(script, link);
  const result = spawnSync(process.execPath, [link, 'npm', 'datafn-core-v1.0.0'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: NEXT_REPO } });
  assert.equal(result.status, 1, 'a skipped gate would exit 0');
  assert.match(result.stderr, /owned by public/);
});
