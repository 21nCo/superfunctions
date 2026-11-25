import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(serverDir, '../../../..');
const uploadPath = 'filefn/examples/full-demo/server/uploads';

test('the generated demo upload is untracked and uploads/ is ignored', () => {
  const tracked = execFileSync('git', ['ls-files', '--', uploadPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(tracked.trim(), '');

  const sample = `${uploadPath}/demo-org/noise.bin`;
  const ignored = execFileSync('git', ['check-ignore', '--', sample], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(ignored.trim(), sample);
});

test('the demo server starts without the generated image', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error(`server did not start\n${stdout}\n${stderr}`)), 10000);
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        const match = /^Server is running on port (\d+)\r?\n/m.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server exited with ${signal ?? code}\n${stdout}\n${stderr}`));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 204);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  }
});
