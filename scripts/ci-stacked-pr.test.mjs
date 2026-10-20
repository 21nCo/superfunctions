import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('CI accepts all PR bases and retains affected-workspace planning', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  // A bare event mapping has no base filter, so readiness branch names are accepted.
  assert.match(workflow, /^  pull_request:\s*\n  workflow_dispatch:/m);
  assert.match(workflow, /run: node scripts\/ci-plan\.mjs/);
  assert.match(workflow, /needs: plan/);
  assert.match(workflow, /needs\.plan\.outputs\.run_js/);
});

test('stacked PR compares actual base SHA and selects only its changed package', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stacked-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const name of ['changed', 'untouched']) {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, scripts: { test: 'node test.js', build: 'node build.js' } }));
  }
  git('add', '.'); git('commit', '-qm', 'base');
  // The stacked base has changes relative to the original main-line commit.
  writeFileSync(path.join(root, 'untouched', 'base-only.ts'), 'export const base = 1;');
  git('add', '.'); git('commit', '-qm', 'stack base');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'changed', 'index.ts'), 'export const changed = 1;');
  git('add', '.'); git('commit', '-qm', 'child');
  const event = path.join(root, 'event.json');
  writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main' }, pull_request: { base: { sha: baseSha, ref: 'codex/shared-readiness-sf-next-20261018' } } }));
  const outputs = path.join(root, 'outputs');
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./ci-plan.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: outputs },
  }));
  assert.equal(result.baseRef, baseSha);
  assert.deepEqual(result.changedFiles, ['changed/index.ts']);
  assert.deepEqual(result.jsPackages, ['changed']);
  assert.equal(result.fullJs, false);
  assert.match(readFileSync(outputs, 'utf8'), /run_js<<__CI_EOF__\ntrue\n/);
  assert.doesNotMatch(readFileSync(outputs, 'utf8'), /untouched/);
});
