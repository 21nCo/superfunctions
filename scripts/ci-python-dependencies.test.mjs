import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Python CI installs target dev dependencies locally in runtime dependency order', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'python-ci-local-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifests = {
    core: ['local-core', [], []],
    adapter: ['local-adapter', ['local-core>=1'], ['unused-tool>=1']],
    unused: ['unused-tool', [], []],
    target: ['local-target', ['local-core>=1'], ['pytest>=7', 'local-adapter>=1']],
  };
  for (const [dir, [name, dependencies, dev]] of Object.entries(manifests)) {
    mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, dir, 'pyproject.toml'),
      `[project]\nname = "${name}"\ndependencies = ${JSON.stringify(dependencies)}\n` +
      `[project.optional-dependencies]\ndev = ${JSON.stringify(dev)}\n`);
  }
  const output = execFileSync(process.execPath,
    [fileURLToPath(new URL('./ci-run-python-package.mjs', import.meta.url)), '--dry-run', 'target'],
    { cwd: root, encoding: 'utf8' });
  assert.match(output, /pip install -e core -e adapter\n/);
  assert.match(output, /pip install -e target\[dev\]/);
  assert.doesNotMatch(output, /-e unused/);
  assert.doesNotMatch(output, /-e adapter\[dev\]/);

  // A change in a test-only local dependency must schedule its consumer too.
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'adapter', 'implementation.py'), 'value = 1\n');
  git('add', '.');
  git('commit', '-qm', 'adapter change');
  const eventPath = path.join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base, ref: 'main' } } }));
  const plan = JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL('./ci-plan.mjs', import.meta.url))], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: path.join(root, 'outputs') },
    }));
  assert.equal(plan.fullPython, false);
  assert.deepEqual(plan.pythonPackages.map(p => p.name), ['local-adapter', 'local-target']);
});
