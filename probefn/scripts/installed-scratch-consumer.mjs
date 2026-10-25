import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '@probefn/storage';
const filename = fileURLToPath(import.meta.url);
if (process.argv[2] === 'child') {
  const [directory, phase] = process.argv.slice(3);
  const store = new ArtifactStore({ repoRoot: directory });
  const hold = scratch => { fs.writeSync(1, JSON.stringify({ id: scratch.id, filename: scratch.filename }) + '\nREADY\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
  await store.withTraceScratch('run', '.artifacts/runs/run/trace.zip', async scratch => {
    if (phase === 'prepared') hold(scratch);
    await scratch.producing(); await writeFile(scratch.filename, 'PK installed trace');
    if (phase === 'producing') hold(scratch);
    await scratch.seal(); if (phase === 'sealed') hold(scratch);
    await store.importArtifactFile('.artifacts/runs/run/trace.zip', scratch.filename);
    if (phase === 'imported') hold(scratch);
    await scratch.admitted(); if (phase === 'cleaned') await scratch.cleanup(); hold(scratch);
  });
} else {
  for (const phase of ['prepared', 'producing', 'sealed', 'imported', 'admitted', 'cleaned']) {
    const directory = await mkdtemp(path.join(process.cwd(), 'installed-scratch-'));
    const child = spawn(process.execPath, [filename, 'child', directory, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', data => { errors += String(data); });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child deadline: ' + errors)), 10000);
        child.stdout.on('data', data => { output += String(data); if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exit ${code}: ${errors}`)); });
      });
      const record = JSON.parse(output.split('\n')[0]);
      const store = new ArtifactStore({ repoRoot: directory });
      await assert.rejects(store.recoverTraceScratch('run'), { code: 'E_SESSION_ALREADY_RUNNING' });
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
      const page = await store.recoverTraceScratch('run'); assert.equal(page.records.length, 1);
      if (phase === 'producing') {
        assert.equal(page.records[0].state, 'quarantined'); assert.equal(page.records[0].removed, false);
        assert.equal(await readFile(record.filename, 'utf8'), 'PK installed trace');
      } else if (phase === 'sealed') {
        assert.equal(page.records[0].state, 'sealed');
        assert.equal(await store.reconcileTraceScratch('run', record.id), '.artifacts/runs/run/trace.zip');
        assert.equal(await readFile(path.join(directory, '.artifacts/runs/run/trace.zip'), 'utf8'), 'PK installed trace');
        assert.equal((await store.recoverTraceScratch('run')).records[0].removed, true);
      } else assert.equal(page.records[0].removed, true);
      if (!['prepared', 'producing'].includes(phase)) {
        assert.equal((await new ArtifactStore({ repoRoot: directory }).recoverTraceScratch('run')).records[0].state, 'cleaned');
        await store.acknowledgeTraceScratch('run', '.artifacts/runs/run/trace.zip');
        assert.deepEqual((await store.recoverTraceScratch('run')).records, []);
      }
      console.log(JSON.stringify({ installedScratchCrash: phase, passed: true }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
      await rm(directory, { recursive: true, force: true });
    }
  }
}
