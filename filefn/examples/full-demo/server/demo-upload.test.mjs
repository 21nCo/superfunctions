import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(serverDir, '../../../..');
const trackedPng = 'filefn/examples/full-demo/server/uploads/demo-org/demo-user/file_mlltua60_pgl0im/ver_mlltua60_wnbwvj-output.png';

test('the generated demo upload is untracked and uploads/ is ignored', () => {
  const tracked = execFileSync('git', ['ls-files', '--', trackedPng], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(tracked.trim(), '');

  const sample = join(serverDir, 'uploads/demo-org/noise.bin');
  mkdirSync(dirname(sample), { recursive: true });
  try {
    writeFileSync(sample, 'demo noise');
    const ignored = execFileSync('git', ['check-ignore', '-v', '--', 'filefn/examples/full-demo/server/uploads/demo-org/noise.bin'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.match(ignored, /uploads\//);
    const status = execFileSync('git', ['status', '--short', '--', 'filefn/examples/full-demo/server/uploads/demo-org/noise.bin'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(status.trim(), '');
  } finally {
    rmSync(sample, { force: true });
  }
});

test('the demo server starts without the generated image', async () => {
  const port = 18765;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start\n${output}`)), 10000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Server is running')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code}\n${output}`));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    assert.equal(response.status, 204);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }
});
