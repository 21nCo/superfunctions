// SFNS-124: both publish workflows run the release owner gate and the release CI gate right after the immutable-tag
// check and before anything is installed, built or packed. The CI job that runs this test installs no npm packages,
// so the workflow YAML is parsed here for the subset these workflows use: a job's mappings and its step list.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// A dispatch may name a tag made before the gates existed, so both gates come from the run's own commit.
const ownerRun = kind =>
  [
    'set -euo pipefail',
    'gates="${RUNNER_TEMP}/release-gates"',
    '# The dispatching branch may have moved or been deleted since dispatch; fetch its commit by SHA if needed.',
    'git cat-file -e "${GITHUB_SHA}^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "${GITHUB_SHA}"',
    'git worktree add --detach "${gates}" "${GITHUB_SHA}"',
    `node "\${gates}/scripts/assert-release-owner.mjs" ${kind} "\${RELEASE_TAG}"`,
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
    assert.equal(steps[ci].run, `node "\${RUNNER_TEMP}/release-gates/scripts/assert-release-ci.mjs" "\${{ ${workflow.refOutput} }}"`);
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

test('publish-tag.yml: every run but a channel-only dispatch first proves its own commit is the tag commit', () => {
  const { steps } = readJob('publish-tag.yml', 'build');
  const names = steps.map(step => step.name ?? step.uses);
  const belongs = names.indexOf('Require the run to belong to the release tag commit');
  assert.ok(belongs !== -1 && belongs < names.indexOf('Require this repository to own the release'));
  assert.equal(steps[belongs].if, '!inputs.channel_only');
});

for (const { file, kind, tag, manifestEntry } of [
  { file: 'publish-tag.yml', kind: 'npm', tag: 'widget-core-v0.1.0-beta.0', manifestEntry: { releases: { 'widget-core': 'public' } } },
  { file: 'publish-python.yml', kind: 'python', tag: 'python-widget-v0.1.0', manifestEntry: { python: { widget: 'public' } } },
]) {
  test(`${file}: the owner step gates a dispatch of a tag made before the gates existed (${kind})`, async t => {
    const { steps } = readJob(file, 'build');
    const step = steps.find(candidate => candidate.name === 'Require this repository to own the release');
    const temp = mkdtempSync(path.join(tmpdir(), 'release-gate-legacy-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const source = path.join(temp, 'source');
    const origin = path.join(temp, 'origin.git');
    const repo = path.join(temp, 'repo');
    mkdirSync(source);
    const gitIn = cwd => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const src = gitIn(source);
    src('init', '-q');
    src('config', 'user.name', 'Release gate test');
    src('config', 'user.email', 'release-gate-test@example.invalid');
    // The legacy tag: a commit with neither the gate script nor an ownership manifest.
    writeFileSync(path.join(source, 'README.md'), 'legacy release\n');
    src('add', '.');
    src('commit', '-q', '-m', 'Legacy release');
    src('tag', tag);
    // The dispatching commit: the gates and a manifest that gives the release to public.
    mkdirSync(path.join(source, 'scripts'));
    for (const script of ['assert-release-owner.mjs', 'assert-release-ci.mjs', 'owners.mjs', 'resolve-release-tag.mjs']) {
      copyFileSync(path.join(import.meta.dirname, script), path.join(source, 'scripts', script));
    }
    writeFileSync(
      path.join(source, 'superfunctions.owners.json'),
      JSON.stringify({ version: 1, paths: { scripts: 'public' }, rootFiles: { public: ['README.md'] }, ...manifestEntry }),
    );
    src('add', '.');
    src('commit', '-q', '-m', 'Add the release gates');
    const workflowCommit = src('rev-parse', 'HEAD');
    src('branch', '-M', 'dispatch');
    execFileSync('git', ['clone', '-q', '--bare', source, origin]);
    execFileSync('git', ['-C', origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
    // The tag checkout holds only the tag commit, as if the dispatching branch had moved or been deleted.
    execFileSync('git', ['clone', '-q', '--depth=1', '--branch', tag, `file://${origin}`, repo], { stdio: 'ignore' });
    const git = gitIn(repo);
    assert.throws(() => git('cat-file', '-e', `${workflowCommit}^{commit}`), 'the dispatching commit starts out missing');
    const run = (repository, runnerTemp) =>
      spawnSync('bash', ['-c', step.run], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_SHA: workflowCommit, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository },
      });
    const runnerTemp = mkdtempSync(path.join(temp, 'runner-'));
    const owned = run('21nCo/superfunctions', runnerTemp);
    assert.equal(owned.status, 0, owned.stderr);
    // The CI step that follows runs from the same worktree, which holds the dispatching commit's gate.
    assert.equal(existsSync(path.join(runnerTemp, 'release-gates', 'scripts', 'assert-release-ci.mjs')), true);
    assert.match(owned.stdout, /widget(?:-core)? is owned by public/);
    const wrong = run('21nCo/super-functions.next', mkdtempSync(path.join(temp, 'runner-')));
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /owned by public \(21nCo\/superfunctions\)/);
    // The tag checkout is untouched: still the legacy commit, with no gate files.
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', `${tag}^{commit}`));
    assert.equal(existsSync(path.join(repo, 'scripts')), false);
  });
}
