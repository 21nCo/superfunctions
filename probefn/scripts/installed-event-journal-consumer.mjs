import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const target = '.artifacts/runs/run/events/console.ndjson';
if (process.argv[2] === 'child') {
  const [root, mode] = process.argv.slice(3);
  const originalOpen = fsp.open;
  const hold = () => { fs.writeSync(1, 'READY\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
  fsp.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('console.ndjson')) {
      const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
      let wrote = false;
      handle.writeFile = async bytes => {
        if (mode === 'before') hold();
        if (mode === 'partial') { const chunk = Buffer.from(bytes); await write(chunk.subarray(0, chunk.indexOf(Buffer.from('😀')) + 2)); await sync(); hold(); }
        await write(bytes); wrote = true;
      };
      handle.sync = async () => { await sync(); if (wrote && mode === 'after') hold(); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const { ArtifactStore } = await import('@probefn/storage');
  await new ArtifactStore({ repoRoot: root }).createEventSink('run', 'console', 'events').append({ message: '😀 installed', token: 'INSTALLED_SECRET_MUST_NOT_PERSIST' });
  throw new Error('Crash stage not reached');
} else {
  const { ArtifactStore } = await import('@probefn/storage');
  for (const mode of ['before', 'partial', 'after']) {
    const root = await fsp.mkdtemp(path.join(process.cwd(), 'journal-consumer-'));
    let child;
    try {
      const store = new ArtifactStore({ repoRoot: root });
      await store.createEventSink('run', 'console', 'events').append({ message: 'prior' });
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', root, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
      await new Promise((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => reject(new Error('Child deadline: ' + stderr)), 10000);
        child.stdout.on('data', bytes => { stdout += String(bytes); if (stdout.includes('READY')) { clearTimeout(timer); resolve(); } });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('Child exit ' + code + ': ' + stderr)); });
      });
      await assert.rejects(store.recoverEventWrites('run'), { code: 'E_SESSION_ALREADY_RUNNING' });
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
      assert(!(await fsp.readFile(path.join(root, '.artifacts/.quota.sqlite'))).includes(Buffer.from('INSTALLED_SECRET_MUST_NOT_PERSIST')));
      const reopened = new ArtifactStore({ repoRoot: root });
      assert.deepEqual(await reopened.recoverEventWrites('run'), { failed: false });
      const bytes = await fsp.readFile(path.join(root, target), 'utf8');
      assert.equal(bytes.trim().split('\n').length, 2); assert(bytes.includes('😀 installed')); assert(!bytes.includes('INSTALLED_SECRET_MUST_NOT_PERSIST'));
      assert.deepEqual(await reopened.recoverEventWrites('run'), { failed: false });
      assert.equal(await fsp.readFile(path.join(root, target), 'utf8'), bytes);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
  console.log('Installed event journal: three independent SIGKILL/reopen stages, live-owner fencing, redaction and duplicate-free recovery passed');
}
