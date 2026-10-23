/** Launch the pinned UI command against an owned smoke test or the repository projects; inspect HTTP and stop it. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repository = process.argv.includes('--repository');
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultConfig = process.argv.includes('--default-config');
assert.ok(!(repository && defaultConfig), 'Choose one project mode');
const root = await mkdtemp(join(tmpdir(), 'shared-vitest-ui-'));
const probe = createServer();
probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const reportPath = join(root, 'results.json');
const url = `http://127.0.0.1:${port}`;
let child;
let exited;
let output = '';
const deadline = Date.now() + 60000;
async function until(check, description) {
  while (!await check()) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`${description}\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
try {
  const config = join(root, 'vitest.config.mjs');
  await writeFile(config, `export default ${JSON.stringify({ root, test: { globals: true, include: ['smoke.test.js'], maxWorkers: 1 } })};\n`);
  await writeFile(join(root, 'smoke.test.js'), "test('isolated UI smoke', () => expect(2 + 3).toBe(5));\n");
  const command = defaultConfig ? process.execPath : 'npm';
  const selection = repository ? ['--reporter=default', '--reporter=json', '--outputFile', reportPath] : ['--config', config];
  const args = defaultConfig ? [join(repositoryRoot, 'scripts/run-vitest-ui.mjs'), '--api.host', '127.0.0.1', '--api.port', String(port)] : ['run', 'test:ui', '--', ...selection, '--api.host', '127.0.0.1', '--api.port', String(port)];
  child = spawn(command, args, {
    cwd: defaultConfig ? root : new URL('../', import.meta.url), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '' },
  });
  exited = once(child, 'exit');
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  let report;
  if (repository) {
    await until(async () => {
      try { report = JSON.parse(await readFile(reportPath, 'utf8')); return true; }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, 'Repository UI test report was not written');
    assert.equal(report.success, true);
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPassedTests, report.numTotalTests);
    assert.doesNotMatch(output, /Errors\s+[1-9]\d* errors?/);
    assert.ok(report.numTotalTests > 0);
    async function testFiles(directory) {
      const files = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await testFiles(path));
        else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) files.push(relative(repositoryRoot, path));
      }
      return files;
    }
    const expected = [];
    for (const project of ['docsfn/svelte', 'docsfn/sveltekit', 'docsfn/examples/sveltekit-docs-site']) expected.push(...await testFiles(join(repositoryRoot, project)));
    assert.deepEqual(report.testResults.map(result => relative(repositoryRoot, result.name)).sort(), expected.sort());
  } else {
    await until(() => /1 passed/.test(output), 'UI test did not pass');
  }
  const response = await fetch(`${url}/__vitest__/`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Vitest<\/title>/);
  const script = html.match(/<script[^>]*src="([^"]+)"/);
  assert.ok(script, 'UI must reference its application JavaScript');
  const asset = await fetch(new URL(script[1], `${url}/__vitest__/`), { signal: AbortSignal.timeout(3000) });
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).length > 1000, 'UI JavaScript must be served');
  assert.match(output, /4\.1\.12/);
  console.log(JSON.stringify({ command: 'npm run test:ui', defaultConfig, repository, tests: report?.numPassedTests, files: report?.testResults.length, version: '4.1.12', testPassed: true, htmlStatus: response.status, javascriptStatus: asset.status, port, pid: child.pid }));
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (child) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    let shutdownTimer;
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { shutdownTimer = setTimeout(() => resolve(false), 12000); })]);
    clearTimeout(shutdownTimer);
    if (!stopped) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await exited; }
  }
  await rm(root, { recursive: true, force: true });
}
await assert.rejects(fetch(`${url}/__vitest__/`, { signal: AbortSignal.timeout(1000) }));
console.log(JSON.stringify({ serverStopped: true, temporaryDirectoryRemoved: root }));
