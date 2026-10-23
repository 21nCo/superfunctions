/** Launch the pinned UI command against one owned temporary test; inspect HTTP and stop it. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'shared-vitest-ui-'));
const probe = createServer();
probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
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
  await writeFile(config, `export default ${JSON.stringify({ root, test: { globals: true, include: ['smoke.test.js'], maxWorkers: 1, minWorkers: 1 } })};\n`);
  await writeFile(join(root, 'smoke.test.js'), "test('isolated UI smoke', () => expect(2 + 3).toBe(5));\n");
  child = spawn('npm', ['run', 'test:ui', '--', '--config', config, '--api.host', '127.0.0.1', '--api.port', String(port)], {
    cwd: new URL('../', import.meta.url), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '' },
  });
  exited = once(child, 'exit');
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  await until(() => /1 passed/.test(output), 'UI test did not pass');
  const response = await fetch(`${url}/__vitest__/`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Vitest<\/title>/);
  const script = html.match(/<script[^>]*src="([^"]+)"/);
  assert.ok(script, 'UI must reference its application JavaScript');
  const asset = await fetch(new URL(script[1], `${url}/__vitest__/`), { signal: AbortSignal.timeout(3000) });
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).length > 1000, 'UI JavaScript must be served');
  assert.match(output, /3\.2\.7/);
  console.log(JSON.stringify({ command: 'npm run test:ui', version: '3.2.7', testPassed: true, htmlStatus: response.status, javascriptStatus: asset.status, port, pid: child.pid }));
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (child) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!stopped) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await exited; }
  }
  await rm(root, { recursive: true, force: true });
}
await assert.rejects(fetch(`${url}/__vitest__/`, { signal: AbortSignal.timeout(1000) }));
console.log(JSON.stringify({ serverStopped: true, temporaryDirectoryRemoved: root }));
