// SFNS-124: both publish workflows run the release owner gate and the release CI gate right after the immutable-tag
// check and before anything is installed, built or packed. The CI job that runs this test installs no npm packages,
// so the workflow YAML is parsed here for the subset these workflows use: a job's mappings and its step list.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workflowsDir = path.join(import.meta.dirname, '..', '.github', 'workflows');
const indentOf = line => line.length - line.trimStart().length;
const isContent = line => line.trim() !== '' && !line.trimStart().startsWith('#');

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
  return trimmed;
}

/** The lines of the block under `key:` that starts at `indent`, searching from `from` to the end of `lines`. */
function block(lines, key, indent, from = 0, to = lines.length) {
  const start = lines.findIndex((line, index) => index >= from && index < to && indentOf(line) === indent && line.trim() === `${key}:`);
  assert.notEqual(start, -1, `no ${key}: at indent ${indent}`);
  let end = start + 1;
  while (end < to && (!isContent(lines[end]) || indentOf(lines[end]) > indent)) end += 1;
  return { start: start + 1, end };
}

/** A mapping's scalar entries and nested mappings, read from the lines of one block at `indent`. */
function mapping(lines, indent) {
  const result = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isContent(line) || indentOf(line) !== indent) continue;
    const [, key, rest] = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/) ?? [];
    if (!key) continue;
    if (rest === '|' || rest === '>' || rest === '') {
      const nested = [];
      while (index + 1 < lines.length && (!isContent(lines[index + 1]) || indentOf(lines[index + 1]) > indent)) nested.push(lines[(index += 1)]);
      const childIndent = Math.min(...nested.filter(isContent).map(indentOf));
      // A `|` block keeps its lines and ends with exactly one newline (YAML's default "clip" chomping).
      const text = nested.map(item => item.slice(childIndent)).join('\n').replace(/\n*$/, '\n');
      result[key] = rest === '' ? mapping(nested, childIndent) : text;
    } else {
      result[key] = unquote(rest);
    }
  }
  return result;
}

/** The steps and permissions of `job` in a workflow file. */
function readJob(file, job) {
  const lines = readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');
  const jobs = block(lines, 'jobs', 0);
  const jobBlock = block(lines, job, 2, jobs.start, jobs.end);
  const stepsBlock = block(lines, 'steps', 4, jobBlock.start, jobBlock.end);
  const permissions = block(lines, 'permissions', 4, jobBlock.start, jobBlock.end);
  const steps = [];
  let current;
  for (const line of lines.slice(stepsBlock.start, stepsBlock.end)) {
    if (isContent(line) && indentOf(line) === 6 && line.trimStart().startsWith('- ')) {
      current = [`${' '.repeat(8)}${line.trimStart().slice(2)}`];
      steps.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return { steps: steps.map(stepLines => mapping(stepLines, 8)), permissions: mapping(lines.slice(permissions.start, permissions.end), 6) };
}

// Both gates come from the run's own commit (a dispatch may name a tag made before the gates existed) and read the tag
// checkout's manifests; only a channel-only npm dispatch of a tag with neither manifest reads the run commit's.
const ownerRun = kind =>
  [
    'set -euo pipefail',
    'gates="${RUNNER_TEMP}/release-gates"',
    '# The dispatching branch may have moved or been deleted since dispatch; fetch its commit by SHA if needed.',
    'git cat-file -e "${GITHUB_SHA}^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "${GITHUB_SHA}"',
    'git worktree add --detach "${gates}" "${GITHUB_SHA}"',
    ...(kind === 'npm'
      ? [
          'manifests="${GITHUB_WORKSPACE}"',
          // Only a tag with neither manifest predates them; a tag with only the next manifest still decides.
          '# Absent means nothing at the path at all: a directory or a dangling symlink there still makes the tag decide.',
          'absent() { [[ ! -e "$1" && ! -L "$1" ]]; }',
          'if [[ "${CHANNEL_ONLY}" == "true" ]] && absent "${manifests}/superfunctions.owners.json" && absent "${manifests}/superfunctions.owners.next.json"; then manifests="${gates}"; fi',
          'node "${gates}/scripts/assert-release-owner.mjs" npm "${RELEASE_TAG}" --root "${manifests}"',
        ]
      : ['node "${gates}/scripts/assert-release-owner.mjs" python "${RELEASE_TAG}" --root "${GITHUB_WORKSPACE}"']),
    '',
  ].join('\n');

const WORKFLOWS = [
  {
    file: 'publish-tag.yml',
    immutable: 'Require immutable release tag',
    refOutput: 'steps.ref.outputs.release_commit',
    kind: 'npm',
    firstInstall: 'Install package dependencies',
    ciCondition: '!inputs.channel_only',
    ownerRun: ownerRun('npm'),
  },
  {
    file: 'publish-python.yml',
    immutable: 'Require immutable tag',
    refOutput: 'steps.source.outputs.release_commit',
    kind: 'python',
    firstInstall: 'Install release tools',
    ciCondition: undefined,
    ownerRun: ownerRun('python'),
  },
];

for (const workflow of WORKFLOWS) {
  test(`${workflow.file}: the owner and CI gates follow the immutable-tag check and precede every install, build and pack`, () => {
    const { steps, permissions } = readJob(workflow.file, 'build');
    const names = steps.map(step => step.name ?? step.uses);
    const at = name => {
      const index = names.indexOf(name);
      assert.notEqual(index, -1, `${workflow.file} build job has no step ${JSON.stringify(name)}: ${names.join(' | ')}`);
      return index;
    };
    const owner = at('Require this repository to own the release');
    const ci = at('Require successful CI on the release commit');
    assert.equal(owner, at(workflow.immutable) + 1, 'the owner gate runs right after the immutable-tag check');
    assert.equal(ci, owner + 1, 'the CI gate runs right after the owner gate');
    assert.ok(ci < at(workflow.firstInstall), `both gates run before ${workflow.firstInstall}`);

    // Before the gates only checkout, toolchain setup and the run/tag checks happen: nothing is installed, built or packed.
    for (const step of steps.slice(0, owner)) {
      if (step.uses) assert.match(step.uses, /^actions\/(?:checkout|setup-node|setup-python)@/, `${step.uses} runs before the gates`);
      assert.doesNotMatch(step.run ?? '', /npm (?:install|ci|pack|publish)|pip install|pack-release-package|python_release\.py/, `${step.name} runs before the gates`);
    }

    assert.equal(steps[owner].run, workflow.ownerRun);
    assert.equal(steps[owner].if, undefined, 'the owner gate applies to every run, channel-only dispatches included');
    assert.equal(steps[ci].run, `node "\${RUNNER_TEMP}/release-gates/scripts/assert-release-ci.mjs" "\${{ ${workflow.refOutput} }}" --root "\${GITHUB_WORKSPACE}"`);
    assert.deepEqual(steps[owner].env, workflow.kind === 'npm' ? { CHANNEL_ONLY: '${{ inputs.channel_only }}' } : undefined);
    assert.equal(steps[ci].if, workflow.ciCondition);
    assert.deepEqual(steps[ci].env, { GITHUB_TOKEN: '${{ github.token }}' });
    assert.deepEqual(permissions, { contents: 'read', actions: 'read', checks: 'read' });
  });
}

test('the publish jobs depend on the build job, so a refused gate publishes nothing', () => {
  for (const file of ['publish-tag.yml', 'publish-python.yml']) {
    const text = readFileSync(path.join(workflowsDir, file), 'utf8');
    const publish = text.slice(text.indexOf('\n  publish:\n'));
    assert.match(publish, /^\n {2}publish:\n {4}needs: build\n/, `${file} publish job needs build`);
  }
});

test('publish-tag.yml: channel reconciliation is bound to the commit the build job approved', () => {
  const { steps } = readJob('publish-tag.yml', 'reconcile-channel');
  const guard = steps.find(step => step.name === 'Require immutable release tag');
  assert.equal(guard.run, 'node ./scripts/assert-release-ref.mjs "${RELEASE_TAG}" "${{ needs.build.outputs.release_commit }}"');
  const names = steps.map(step => step.name ?? step.uses);
  // Before anything is installed for reconciliation, and before the registry is touched.
  assert.ok(names.indexOf('Require immutable release tag') < names.indexOf('Setup OIDC dist-tag client'));
  assert.ok(names.indexOf('Require immutable release tag') < names.indexOf('Keep prereleases off latest'));
});

test('publish-tag.yml: every run but a channel-only dispatch first proves its own commit is the tag commit', () => {
  const { steps } = readJob('publish-tag.yml', 'build');
  const names = steps.map(step => step.name ?? step.uses);
  const belongs = names.indexOf('Require the run to belong to the release tag commit');
  assert.ok(belongs !== -1 && belongs < names.indexOf('Require this repository to own the release'));
  assert.equal(steps[belongs].if, '!inputs.channel_only');
});

// The build job is parsed the same way the release gates read it, so a YAML shape those gates cannot read fails
// this test. verify-registry has no permissions block, which that parser requires, so its setup-node step is read
// from the job's own text. Both steps the audit found on a floating tag use the v4.4.0 commit already pinned by
// the other jobs (actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020).
test('publish-tag.yml: Node setup actions are full commit SHAs, including the build and verify-registry steps', () => {
  const text = readFileSync(path.join(workflowsDir, 'publish-tag.yml'), 'utf8');
  const pin = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
  const uses = [...text.matchAll(/^ {8}uses: (actions\/setup-node@\S+)(?: # (\S+))?$/gm)];
  assert.equal(uses.length, 4, 'publish-tag.yml has four setup-node steps');
  for (const match of uses) {
    assert.match(match[1], /^actions\/setup-node@[0-9a-f]{40}$/, match[1]);
    assert.equal(match[2], 'v4.4.0');
  }
  assert.doesNotMatch(text, /actions\/setup-node@v\d/);
  const { steps } = readJob('publish-tag.yml', 'build');
  const setup = steps.find(step => step.name === 'Setup Node.js');
  assert.equal(setup.uses, `${pin} # v4.4.0`);
  const verifyStart = text.indexOf('\n  verify-registry:\n');
  const verifyEnd = text.indexOf('\n  reconcile-channel:\n');
  assert.ok(verifyStart !== -1 && verifyEnd > verifyStart);
  assert.match(text.slice(verifyStart, verifyEnd), new RegExp(`uses: ${pin} # v4\\.4\\.0`));
});

const ownersManifest = (kind, release, owner) => {
  const entry = { [kind === 'npm' ? 'releases' : 'python']: { [release]: 'public' } };
  if (owner === 'public') return { version: 1, paths: { scripts: 'public' }, rootFiles: { public: ['README.md'] }, ...entry };
  // A public manifest without the release, plus a next manifest that owns it.
  return { version: 1, paths: { scripts: 'public' }, rootFiles: { public: ['README.md'] } };
};

/**
 * Runs a workflow's owner step in a tag checkout that holds only the tag commit, with the run's own commit (the
 * gates plus `runOwner`'s manifest) fetched by SHA, as when the dispatching branch has moved since dispatch.
 * `tagOwner` null means the tag predates the manifests; 'next-only' gives the tag only a next manifest that owns the release;
 * 'next-dir' and 'next-symlink' put a directory or a dangling symlink at the next manifest's path and no public manifest.
 * `nextCi` is the `ci` section of every next manifest written.
 */
function ownerStepFixture(t, { file, kind, tag, release, tagOwner, runOwner = 'public', nextCi }) {
  const step = readJob(file, 'build').steps.find(candidate => candidate.name === 'Require this repository to own the release');
  const temp = mkdtempSync(path.join(tmpdir(), 'release-gate-dispatch-'));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // No detached background gc or maintenance after a fetch may still be writing when the folder is removed.
  const quietGit = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false' };
  const source = path.join(temp, 'source');
  const origin = path.join(temp, 'origin.git');
  const repo = path.join(temp, 'repo');
  mkdirSync(source);
  const gitEnv = { ...process.env, ...quietGit };
  const gitIn = cwd => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
  const src = gitIn(source);
  src('init', '-q');
  src('config', 'user.name', 'Release gate test');
  src('config', 'user.email', 'release-gate-test@example.invalid');
  const writeManifests = owner => {
    rmSync(path.join(source, 'superfunctions.owners.json'), { force: true });
    rmSync(path.join(source, 'superfunctions.owners.next.json'), { recursive: true, force: true });
    if (owner === null) return;
    if (owner === 'next-dir') {
      mkdirSync(path.join(source, 'superfunctions.owners.next.json'));
      writeFileSync(path.join(source, 'superfunctions.owners.next.json', 'README.md'), 'not a manifest\n');
      return;
    }
    if (owner === 'next-symlink') {
      symlinkSync('missing-manifest.json', path.join(source, 'superfunctions.owners.next.json'));
      return;
    }
    if (owner !== 'next-only') writeFileSync(path.join(source, 'superfunctions.owners.json'), JSON.stringify(ownersManifest(kind, release, owner)));
    if (owner === 'next' || owner === 'next-only') {
      writeFileSync(path.join(source, 'superfunctions.owners.next.json'), JSON.stringify({ version: 1, [kind === 'npm' ? 'releases' : 'python']: { [release]: 'next' }, ...(nextCi ? { ci: nextCi } : {}) }));
    }
  };
  // The tag commit: no gate scripts; manifests only when tagOwner is set.
  writeFileSync(path.join(source, 'README.md'), 'release\n');
  writeManifests(tagOwner);
  src('add', '-A');
  src('commit', '-q', '-m', 'Tagged release');
  src('tag', tag);
  // The run's own commit: the gates and runOwner's manifests.
  mkdirSync(path.join(source, 'scripts'));
  for (const script of ['assert-release-owner.mjs', 'assert-release-ci.mjs', 'owners.mjs', 'resolve-release-tag.mjs']) {
    copyFileSync(path.join(import.meta.dirname, script), path.join(source, 'scripts', script));
  }
  writeManifests(runOwner);
  src('add', '-A');
  src('commit', '-q', '-m', 'Add the release gates');
  const workflowCommit = src('rev-parse', 'HEAD');
  src('branch', '-M', 'dispatch');
  execFileSync('git', ['clone', '-q', '--bare', source, origin], { env: gitEnv });
  execFileSync('git', ['-C', origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true'], { env: gitEnv });
  execFileSync('git', ['clone', '-q', '--depth=1', '--branch', tag, `file://${origin}`, repo], { stdio: 'ignore', env: gitEnv });
  const git = gitIn(repo);
  assert.throws(() => git('cat-file', '-e', `${workflowCommit}^{commit}`), 'the run commit starts out missing from the tag checkout');
  const run = ({ repository = '21nCo/superfunctions', channelOnly = 'false' } = {}) => {
    const runnerTemp = mkdtempSync(path.join(temp, 'runner-'));
    const result = spawnSync('bash', ['-c', step.run], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...gitEnv, RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: repo, GITHUB_SHA: workflowCommit, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository, CHANNEL_ONLY: channelOnly },
    });
    // Whatever happened, the tag checkout is untouched and the CI step's gate is in place.
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', `${tag}^{commit}`));
    assert.equal(existsSync(path.join(repo, 'scripts')), false);
    if (result.status === 0) assert.equal(existsSync(path.join(runnerTemp, 'release-gates', 'scripts', 'assert-release-ci.mjs')), true);
    return { ...result, runnerTemp };
  };
  /** Runs the owner step and then the workflow's CI step, as written, on the tag commit with an unreachable API. */
  const runWithCi = options => {
    const owner = run(options);
    assert.equal(owner.status, 0, owner.stderr);
    const ciStep = readJob(file, 'build').steps.find(candidate => candidate.name === 'Require successful CI on the release commit');
    const script = ciStep.run.replace(/\$\{\{ steps\.\w+\.outputs\.release_commit \}\}/, git('rev-parse', `${tag}^{commit}`));
    const env = { ...gitEnv, RUNNER_TEMP: owner.runnerTemp, GITHUB_WORKSPACE: repo, GITHUB_REPOSITORY: options.repository, GITHUB_TOKEN: 'test-github-token', GH_TOKEN: '' };
    // Nothing may be read: a request to this closed port would fail as an API error instead of the refusal.
    return spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8', env: { ...env, GITHUB_API_URL: 'http://127.0.0.1:9' } });
  };
  return { run, runWithCi };
}

const DISPATCHES = [
  { file: 'publish-tag.yml', kind: 'npm', tag: 'widget-core-v0.1.0-beta.0', release: 'widget-core' },
  { file: 'publish-python.yml', kind: 'python', tag: 'python-widget-v0.1.0', release: 'widget' },
];

for (const dispatch of DISPATCHES) {
  test(`${dispatch.file}: the tag's manifests decide ownership even when the gates come from a newer run commit`, t => {
    const owned = ownerStepFixture(t, { ...dispatch, tagOwner: 'public' }).run();
    assert.equal(owned.status, 0, owned.stderr);
    assert.match(owned.stdout, /is owned by public/);
    // The run commit says public, but the tag gives the release to next: the tag wins and public refuses.
    const tagSaysNext = ownerStepFixture(t, { ...dispatch, tagOwner: 'next', runOwner: 'public' }).run();
    assert.equal(tagSaysNext.status, 1);
    assert.match(tagSaysNext.stderr, /owned by next \(21nCo\/super-functions\.next\)/);
    const wrongRepo = ownerStepFixture(t, { ...dispatch, tagOwner: 'public' }).run({ repository: '21nCo/super-functions.next' });
    assert.equal(wrongRepo.status, 1);
    assert.match(wrongRepo.stderr, /owned by public \(21nCo\/superfunctions\)/);
    // A tag without manifests cannot publish.
    const legacy = ownerStepFixture(t, { ...dispatch, tagOwner: null }).run();
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /superfunctions\.owners\.json not found/);
  });
}

for (const dispatch of DISPATCHES) {
  test(`${dispatch.file}: on next the CI step refuses a next-owned tag as unproven even with a Depot check run configured`, t => {
    const fixture = ownerStepFixture(t, { ...dispatch, tagOwner: 'next', runOwner: 'next', nextCi: { checkRun: 'Depot CI', app: 'depot' } });
    const ci = fixture.runWithCi({ repository: '21nCo/super-functions.next' });
    assert.equal(ci.status, 1);
    assert.match(ci.stderr, /21nCo\/super-functions\.next: its CI is unproven/);
  });
}

test('publish-tag.yml: a channel-only dispatch of a tag made before the manifests is gated by the run commit\'s manifests', t => {
  const legacy = ownerStepFixture(t, { ...DISPATCHES[0], tagOwner: null, runOwner: 'public' });
  const owned = legacy.run({ channelOnly: 'true' });
  assert.equal(owned.status, 0, owned.stderr);
  const wrongRepo = legacy.run({ channelOnly: 'true', repository: '21nCo/super-functions.next' });
  assert.equal(wrongRepo.status, 1);
  assert.match(wrongRepo.stderr, /owned by public \(21nCo\/superfunctions\)/);
  // A channel-only dispatch of a tag that has manifests still follows the tag.
  const tagSaysNext = ownerStepFixture(t, { ...DISPATCHES[0], tagOwner: 'next', runOwner: 'public' }).run({ channelOnly: 'true' });
  assert.equal(tagSaysNext.status, 1);
  // A tag with only the next manifest does not predate the manifests: it decides, and the step refuses before the
  // reconcile job can install a client, instead of taking public ownership from the run commit.
  const nextOnly = ownerStepFixture(t, { ...DISPATCHES[0], tagOwner: 'next-only', runOwner: 'public' }).run({ channelOnly: 'true' });
  assert.equal(nextOnly.status, 1);
  assert.match(nextOnly.stderr, /superfunctions\.owners\.json not found/);
  assert.doesNotMatch(nextOnly.stdout, /is owned by public/);
  // Something other than a manifest at the next manifest's path (a directory or a dangling symlink) is not an absent
  // manifest either: the tag still decides, and it cannot establish ownership.
  for (const tagOwner of ['next-dir', 'next-symlink']) {
    const odd = ownerStepFixture(t, { ...DISPATCHES[0], tagOwner, runOwner: 'public' }).run({ channelOnly: 'true' });
    assert.equal(odd.status, 1, tagOwner);
    assert.doesNotMatch(odd.stdout, /is owned by public/, tagOwner);
  }
});
