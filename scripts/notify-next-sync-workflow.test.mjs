// SFNS-126: .github/workflows/notify-next-sync.yml sends one repository_dispatch event `sync-dev` with payload { sha }
// to 21nCo/super-functions.next on every push to dev in 21nCo/superfunctions, with a 21n-repo-sync installation token
// minted from the next-sync environment's secrets, and skips with a notice when those secrets are absent. The CI job
// that runs this test installs no npm packages, so the workflow is read by a small block-style YAML reader that fails
// on any construct it does not model. The step scripts run under bash, as on the runner, with curl replaced by a stub.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPOSITORY_GUARD, hasRepositoryGuard, workflowGuardErrors } from './verify-owners.mjs';

const FILE = '.github/workflows/notify-next-sync.yml';
const source = readFileSync(path.join(import.meta.dirname, '..', FILE), 'utf8');

const indentOf = line => line.length - line.trimStart().length;
const isContent = line => line.trim() !== '' && !line.trimStart().startsWith('#');

function scalar(text, where) {
  const value = text.replace(/\s+#.*$/, '').trim();
  if (value === '{}') return {};
  if (/^['"]/.test(value)) {
    const quote = value[0];
    assert.ok(value.length > 1 && value.endsWith(quote), `${where}: unterminated quoted scalar ${value}`);
    const inner = value.slice(1, -1);
    return quote === "'" ? inner.replaceAll("''", "'") : JSON.parse(value);
  }
  assert.ok(!/^[[{&*!|>]/.test(value), `${where}: unsupported YAML construct ${value}`);
  return value;
}

/** Parses the block at lines[from..to) whose entries sit at `indent` into a mapping or a sequence. */
function parseBlock(lines, from, to, indent) {
  const isSequence = lines.slice(from, to).find(isContent).trimStart().startsWith('- ');
  const result = isSequence ? [] : {};
  let index = from;
  while (index < to) {
    const line = lines[index];
    if (!isContent(line)) { index += 1; continue; }
    assert.equal(indentOf(line), indent, `${FILE}:${index + 1}: unexpected indentation`);
    let end = index + 1;
    while (end < to && (!isContent(lines[end]) || indentOf(lines[end]) > indent)) end += 1;
    // Blank and comment lines after an entry's last content line belong to whatever follows it.
    while (end > index + 1 && !isContent(lines[end - 1])) end -= 1;
    if (isSequence) {
      assert.ok(line.trimStart().startsWith('- '), `${FILE}:${index + 1}: mixed sequence and mapping`);
      // `- key: value` opens a mapping whose entries sit two columns right of the dash.
      const item = [' '.repeat(indent + 2) + line.trimStart().slice(2), ...lines.slice(index + 1, end)];
      result.push(item[0].trim().match(/^[A-Za-z0-9_-]+:/) ? parseBlock(item, 0, item.length, indent + 2) : scalar(item[0], `${FILE}:${index + 1}`));
    } else {
      const [, key, rest] = line.trim().match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/) ?? [];
      assert.ok(key, `${FILE}:${index + 1}: not a mapping entry`);
      assert.ok(!Object.hasOwn(result, key), `${FILE}:${index + 1}: duplicate key ${key}`);
      const body = lines.slice(index + 1, end);
      const childIndent = Math.min(...body.filter(isContent).map(indentOf));
      if (rest === '|') {
        result[key] = body.map(item => item.slice(childIndent)).join('\n').replace(/\n*$/, '\n');
      } else if (rest === undefined || rest.startsWith('#')) {
        assert.ok(body.some(isContent), `${FILE}:${index + 1}: ${key} has no value`);
        result[key] = parseBlock(lines, index + 1, end, childIndent);
      } else {
        assert.ok(!body.some(isContent), `${FILE}:${index + 1}: multi-line plain scalar under ${key}`);
        result[key] = scalar(rest, `${FILE}:${index + 1}`);
      }
    }
    index = end;
  }
  return result;
}

const lines = source.split(/\r?\n/);
const workflow = parseBlock(lines, lines.findIndex(isContent), lines.length, 0);
const [jobName, ...otherJobs] = Object.keys(workflow.jobs);
const job = workflow.jobs[jobName];
const stepNamed = name => {
  const step = job.steps.find(candidate => candidate.name === name);
  assert.ok(step, `no step named ${name}`);
  return step;
};
const checkStep = stepNamed('Check sync app secrets');
const tokenStep = stepNamed('Mint 21n-repo-sync installation token');
const dispatchStep = stepNamed('Send sync-dev to 21nCo/super-functions.next');

test('triggers only on push to dev', () => {
  assert.deepEqual(workflow.on, { push: { branches: ['dev'] } });
});

test('runs one job, guarded to 21nCo/superfunctions and a dev push', () => {
  assert.deepEqual(otherJobs, []);
  assert.ok(hasRepositoryGuard(job.if), `job if: ${job.if}`);
  assert.equal(job.if, `${REPOSITORY_GUARD} && (github.event_name == 'push' && github.ref == 'refs/heads/dev')`);
  assert.deepEqual(workflowGuardErrors(FILE, source), []);
});

test('takes its secrets from the next-sync environment', () => {
  assert.equal(job.environment, 'next-sync');
});

test('gives the default GITHUB_TOKEN no permissions and never uses it', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.ok(!Object.hasOwn(job, 'permissions'), 'the job must not widen the default token');
  assert.doesNotMatch(source, /secrets\.GITHUB_TOKEN|github\.token/);
});

test('mints a 21n-repo-sync token for super-functions.next only, after the secrets check', () => {
  const [action, ref] = tokenStep.uses.split('@');
  assert.equal(action, 'actions/create-github-app-token');
  assert.match(ref, /^[0-9a-f]{40}$/, 'the action is pinned to a commit');
  assert.equal(tokenStep.if, "steps.sync-app.outputs.configured == 'true'");
  assert.deepEqual(tokenStep.with, {
    'app-id': '${{ secrets.SYNC_APP_ID }}',
    'private-key': '${{ secrets.SYNC_APP_PRIVATE_KEY }}',
    owner: '21nCo',
    repositories: 'super-functions.next',
    'permission-contents': 'write',
  });
  assert.equal(dispatchStep.if, "steps.sync-app.outputs.configured == 'true'");
  assert.equal(dispatchStep.env.GH_TOKEN, '${{ steps.token.outputs.token }}');
  assert.equal(dispatchStep.env.SHA, '${{ github.sha }}');
  // The secrets reach only the check step's environment and the token action's inputs.
  const secretUses = [...source.matchAll(/(?<![\w.-])secrets\.[A-Za-z_]+/g)].map(([match]) => match).sort();
  assert.deepEqual(secretUses, ['secrets.SYNC_APP_ID', 'secrets.SYNC_APP_ID', 'secrets.SYNC_APP_PRIVATE_KEY', 'secrets.SYNC_APP_PRIVATE_KEY']);
  assert.deepEqual(checkStep.env, { SYNC_APP_ID: '${{ secrets.SYNC_APP_ID }}', SYNC_APP_PRIVATE_KEY: '${{ secrets.SYNC_APP_PRIVATE_KEY }}' });
  assert.ok(job.steps.indexOf(checkStep) < job.steps.indexOf(tokenStep) && job.steps.indexOf(tokenStep) < job.steps.indexOf(dispatchStep));
});

/** Runs a step's script the way the runner does (bash -eo pipefail) with the given environment and a temp dir. */
function runStep(step, env, setup = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'notify-next-sync-'));
  try {
    const script = path.join(dir, 'step.sh');
    const output = path.join(dir, 'github-output');
    writeFileSync(script, step.run);
    writeFileSync(output, '');
    const extra = setup(dir) ?? {};
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_SHA: 'test-sha', ...extra, ...env },
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('without both secrets the check succeeds, logs a skip notice and turns the token and dispatch steps off', () => {
  for (const env of [{}, { SYNC_APP_ID: '', SYNC_APP_PRIVATE_KEY: '' }, { SYNC_APP_ID: 'test-app-id' }, { SYNC_APP_PRIVATE_KEY: 'test-private-key' }]) {
    const result = runStep(checkStep, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::notice title=next sync skipped::.*no sync-dev event was sent for test-sha\.$/m);
    assert.equal(result.output, 'configured=false\n');
  }
});

test('with both secrets the check turns the token and dispatch steps on without a notice', () => {
  const result = runStep(checkStep, { SYNC_APP_ID: 'test-app-id', SYNC_APP_PRIVATE_KEY: 'test-private-key' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.output, 'configured=true\n');
});

/**
 * Puts a curl stub first on PATH: it records its arguments in `recorded`, writes a body to --output (or, like curl,
 * to stdout without it) and prints `status`.
 */
function curlStub(status, recorded) {
  return dir => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(args));
const output = args.indexOf('--output');
if (output === -1) process.stdout.write('response-body-from-next');
else fs.writeFileSync(args[output + 1], 'response-body-from-next');
process.stdout.write(${JSON.stringify(status)});
`);
    chmodSync(path.join(bin, 'curl'), 0o755);
    return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  };
}

test('sends exactly { event_type: sync-dev, client_payload: { sha } } to next and prints nothing from it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notify-next-sync-args-'));
  try {
    for (const [status, code] of [['204', 0], ['404', 1]]) {
      const recorded = path.join(dir, `args-${status}.json`);
      const result = runStep(dispatchStep, { GH_TOKEN: 'test-installation-token', SHA: 'test-sha' }, curlStub(status, recorded));
      assert.equal(result.status, code, result.stderr);
      const args = JSON.parse(readFileSync(recorded, 'utf8'));
      assert.equal(args.at(-1), 'https://api.github.com/repos/21nCo/super-functions.next/dispatches');
      assert.equal(args[args.indexOf('--request') + 1], 'POST');
      assert.equal(args[args.indexOf('--output') + 1], '/dev/null');
      assert.ok(args.includes('Authorization: Bearer test-installation-token'));
      assert.deepEqual(JSON.parse(args[args.indexOf('--data') + 1]), { event_type: 'sync-dev', client_payload: { sha: 'test-sha' } });
      assert.doesNotMatch(result.stdout + result.stderr, /response-body-from-next/);
      if (code === 0) assert.equal(result.stdout, 'Sent sync-dev for test-sha to 21nCo/super-functions.next.\n');
      else assert.match(result.stdout, /^::error title=next sync not sent::.*HTTP 404 for test-sha\.$/m);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
