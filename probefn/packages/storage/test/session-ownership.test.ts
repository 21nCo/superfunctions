import { mkdtemp, rm, readdir, unlink, writeFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { SessionOwnership } from '../src/session-ownership.js';

it('rejects a second native owner, survives killed-owner recovery, and fences run aliases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-ownership-'));
  const modulePath = path.resolve('packages/storage/dist/session-ownership.js');
  const args = { repoRoot: root, artifactRoot: '.artifacts', sessionId: 'one', runId: 'run' };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {SessionOwnership} from ${JSON.stringify(modulePath)}; const ownership=await SessionOwnership.acquire(${JSON.stringify(args)}); process.stdout.write('owned\\n'); setInterval(()=>ownership.assertOwned(),100);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  try {
    const ready = await Promise.race([once(child.stdout, 'data').then(([data]) => String(data)), once(child, 'exit').then(() => { throw new Error(diagnostics); })]);
    expect(ready).toBe('owned\n');
    await expect(SessionOwnership.acquire(args)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await expect(SessionOwnership.acquire({ ...args, sessionId: 'two' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    const alias = path.join(root, 'alias'); await symlink(root, alias);
    await expect(SessionOwnership.acquire({ ...args, repoRoot: alias })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    child.kill('SIGKILL'); await once(child, 'exit');
    const recovered = await SessionOwnership.acquire(args);
    recovered.assertOwned(); recovered.release();
    expect(() => recovered.assertOwned()).toThrow('released');
    expect((await readdir(path.join(root, '.artifacts/.ownership'))).filter(name => name.endsWith('.sqlite'))).toHaveLength(3);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['unlink', 'replace'] as const)('fails closed after lock slot %s instead of forking authority', async (operation) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-ownership-'));
  const args = { repoRoot: root, artifactRoot: '.artifacts', sessionId: 'one', runId: 'run' };
  const owner = await SessionOwnership.acquire(args);
  try {
    const directory = await realpath(path.join(root, '.artifacts/.ownership'));
    const name = (await readdir(directory)).find(name => name !== 'registry.sqlite' && name.endsWith('.sqlite'))!;
    const filename = path.join(directory, name);
    await unlink(filename);
    if (operation === 'replace') await writeFile(filename, '');
    expect(() => owner.assertOwned()).toThrow(/disappeared|replaced/);
    await expect(SessionOwnership.acquire(args)).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    owner.release();
    await expect(SessionOwnership.acquire(args)).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  } finally { owner.release(); await rm(root, { recursive: true, force: true }); }
});

it('unwinds partial acquisition without blocking an independent session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-ownership-'));
  const args = { repoRoot: root, artifactRoot: '.artifacts', sessionId: 'same', runId: 'first' };
  const owner = await SessionOwnership.acquire(args);
  try {
    await expect(SessionOwnership.acquire({ ...args, runId: 'second' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    const independent = await SessionOwnership.acquire({ ...args, sessionId: 'other', runId: 'second' });
    independent.release();
  } finally { owner.release(); await rm(root, { recursive: true, force: true }); }
});

it('persists a configurable finite slot budget and permits explicit capacity expansion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-ownership-'));
  const args = { repoRoot: root, artifactRoot: '.artifacts', sessionId: 'one', runId: 'one' };
  try {
    (await SessionOwnership.acquire({ ...args, maxOwnershipSlots: 2 })).release();
    await expect(SessionOwnership.acquire({ ...args, sessionId: 'two', runId: 'two' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
    (await SessionOwnership.acquire({ ...args, sessionId: 'two', runId: 'two', maxOwnershipSlots: 4 })).release();
    (await SessionOwnership.acquire(args)).release();
    await expect(SessionOwnership.acquire({ ...args, maxOwnershipSlots: 2 })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
    await expect(SessionOwnership.acquire({ ...args, maxOwnershipSlots: 1 })).rejects.toMatchObject({ code: 'E_CONFIG_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
