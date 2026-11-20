// SFNS-124: both publish workflows run the release owner gate and the release CI gate right after the immutable-tag
// check and before anything is installed, built or packed. The CI job that runs this test installs no npm packages,
// so the workflow YAML is parsed here for the subset these workflows use: a job's mappings and its step list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      result[key] = rest === '' ? mapping(nested, childIndent) : nested.map(item => item.slice(childIndent)).join('\n');
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

const WORKFLOWS = [
  {
    file: 'publish-tag.yml',
    immutable: 'Require immutable release tag',
    refOutput: 'steps.ref.outputs.release_commit',
    kind: 'npm',
    firstInstall: 'Install package dependencies',
    ciCondition: '!inputs.channel_only',
  },
  {
    file: 'publish-python.yml',
    immutable: 'Require immutable tag',
    refOutput: 'steps.source.outputs.release_commit',
    kind: 'python',
    firstInstall: 'Install release tools',
    ciCondition: undefined,
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

    assert.equal(steps[owner].run, `node ${workflow.kind === 'npm' ? './' : ''}scripts/assert-release-owner.mjs ${workflow.kind} "\${RELEASE_TAG}"`);
    assert.equal(steps[owner].if, undefined, 'the owner gate applies to every run, channel-only dispatches included');
    assert.equal(steps[ci].run, `node ${workflow.kind === 'npm' ? './' : ''}scripts/assert-release-ci.mjs "\${{ ${workflow.refOutput} }}"`);
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
