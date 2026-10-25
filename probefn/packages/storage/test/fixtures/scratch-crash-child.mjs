import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createJiti } from 'jiti';
import { syncBuiltinESMExports } from 'node:module';
const [root, mode] = process.argv.slice(2);
const hold = record => { fs.writeSync(1, JSON.stringify(record) + '\nREADY\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
const originalOpen = fsp.open, originalMkdir = fsp.mkdir, originalRmdir = fsp.rmdir;
fsp.mkdir = async (...args) => {
  const directory = String(args[0]);
  if (path.basename(directory).startsWith('probefn-trace-')) {
    const entry = { id: path.basename(directory).slice('probefn-trace-'.length), filename: path.join(directory, 'trace.zip') };
    if (mode === 'reserved') hold(entry);
    const result = await originalMkdir(...args);
    if (mode === 'created') hold(entry);
    return result;
  }
  return originalMkdir(...args);
};
fsp.rmdir = async (...args) => {
  if (String(args[0]).includes('probefn-trace-')) {
    if (mode === 'removing') hold(receipt);
    const result = await originalRmdir(...args);
    if (mode === 'removed') hold(receipt);
    return result;
  }
  return originalRmdir(...args);
};
let receipt;
fsp.open = async (...args) => {
  const file = await originalOpen(...args);
  if (mode.startsWith('reconcile-') && String(args[0]).endsWith('/runs/run/trace.zip')) {
    const write = file.write.bind(file), sync = file.sync.bind(file);
    let wrote = false;
    file.write = async (buffer, offset, length, position) => {
      if (mode === 'reconcile-partial') { await write(buffer, offset, Math.max(1, Math.floor(length / 2)), position); await sync(); hold(receipt); }
      const result = await write(buffer, offset, length, position); wrote = true; return result;
    };
    file.sync = async () => { await sync(); if (wrote && mode === 'reconcile-after') hold(receipt); };
  }
  return file;
};
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url, { alias: { '@probefn/contracts/errors': new URL('../../../contracts/src/errors.ts', import.meta.url).pathname } });
const { ArtifactStore } = await jiti.import('../../src/artifact-store.ts');
const store = new ArtifactStore({ repoRoot: root });
if (mode.startsWith('reconcile-')) {
  const page = await store.recoverTraceScratch('run');
  receipt = { id: page.records[0].id, filename: root + '/.artifacts/runs/run/.probefn-scratch/probefn-trace-' + page.records[0].id + '/trace.zip' };
  await store.reconcileTraceScratch('run', receipt.id);
  throw new Error('Reconciliation fault was not reached');
}
await store.withTraceScratch('run', '.artifacts/runs/run/trace.zip', async scratch => {
  if (mode === 'prepared') hold(scratch);
  await scratch.producing();
  await fsp.writeFile(scratch.filename, 'PK synthetic durable trace');
  if (mode === 'producing') hold(scratch);
  await scratch.seal();
  if (mode === 'sealed') hold(scratch);
  await store.importArtifactFile('.artifacts/runs/run/trace.zip', scratch.filename);
  if (mode === 'imported') hold(scratch);
  await scratch.admitted();
  if (mode === 'removing' || mode === 'removed' || mode === 'cleaned') { receipt = scratch; await scratch.cleanup(); }
  hold(scratch);
});
