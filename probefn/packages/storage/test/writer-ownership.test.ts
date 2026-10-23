import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifact-store.js';
import { SessionOwnership } from '../src/session-ownership.js';

it('permits explicitly owned nested writers and rejects cross-run or released authority', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'probe-writer-context-'));
  const store = new ArtifactStore({ repoRoot });
  const owner = await SessionOwnership.acquire({ repoRoot, artifactRoot: '.artifacts', sessionId: 'session', runId: 'run' });
  try {
    await owner.run(async () => {
      await store.initializeRunPolicy('run');
      await store.writeArtifact('.artifacts/runs/run/owned.txt', 'owned');
      await store.createEventSink('run', 'owned', 'events').append({ owned: true });
      await expect(store.writeArtifact('.artifacts/runs/other/denied.txt', 'no')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    });
    await expect(store.writeArtifact('.artifacts/runs/run/denied.txt', 'no')).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await expect(readFile(path.join(repoRoot, '.artifacts/runs/run/denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    owner.release();
    expect(() => owner.run(async () => undefined)).toThrow('released');
    await store.writeArtifact('.artifacts/runs/run/released.txt', 'allowed');
    expect(await readFile(path.join(repoRoot, '.artifacts/runs/run/released.txt'), 'utf8')).toBe('allowed');
  } finally { owner.release(); await rm(repoRoot, { recursive: true, force: true }); }
});

it('fences policy, event, deletion and session-state mutations and reserves lock metadata', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'probe-writer-paths-'));
  const store = new ArtifactStore({ repoRoot });
  await store.writeArtifact('.artifacts/runs/run/existing.txt', 'retained');
  const owner = await SessionOwnership.acquire({ repoRoot, artifactRoot: '.artifacts', sessionId: 'session', runId: 'run' });
  try {
    for (const mutation of [
      () => store.initializeRunPolicy('run', { maxArtifactBytes: 1 }),
      () => store.createEventSink('run', 'denied', 'events').append({ denied: true }),
      () => store.deleteArtifact('.artifacts/runs/run/existing.txt'),
      () => store.writeArtifact('.artifacts/session-state/session.json', '{}', { runId: 'other' }),
    ]) await expect(mutation()).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    expect(await readFile(path.join(repoRoot, '.artifacts/runs/run/existing.txt'), 'utf8')).toBe('retained');
    await expect(store.writeArtifact('.artifacts/.ownership/registry.sqlite', 'overwrite')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    owner.release();
    // Failed policy admission must not have tightened the persisted cap.
    await store.writeArtifact('.artifacts/runs/run/after.txt', 'more than one byte');
  } finally { owner.release(); await rm(repoRoot, { recursive: true, force: true }); }
}, 10000);


it('rejects managed directory aliases and symlink routes through unscoped paths', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'probe-writer-alias-'));
  const store = new ArtifactStore({ repoRoot });
  try {
    await store.writeArtifact('.artifacts/runs/run/existing.txt', 'original');
    await symlink(path.join(repoRoot, '.artifacts/runs/run'), path.join(repoRoot, 'alias'));
    for (const name of ['alias/existing.txt', '.ARTIFACTS/runs/run/existing.txt', '.artifacts/RUNS/run/existing.txt', '.artifacts/.OWNERSHIP/registry.sqlite']) {
      await expect(store.writeArtifact(name, 'bad')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    }
    expect(await readFile(path.join(repoRoot, '.artifacts/runs/run/existing.txt'), 'utf8')).toBe('original');
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});


it('rejects a producer awaiting another managed write without partial commit or retained authority', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'probe-nested-writer-'));
  const store = new ArtifactStore({ repoRoot });
  try {
    await expect(store.writeArtifactStream('.artifacts/runs/run/outer.txt', async write => {
      await write('staged');
      await store.writeArtifact('.artifacts/runs/run/inner.txt', 'nested');
    })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED', message: expect.stringContaining('Nested managed') });
    for (const file of ['outer.txt', 'inner.txt']) await expect(readFile(path.join(repoRoot, '.artifacts/runs/run', file))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(repoRoot, '.artifacts/runs/run/.probefn-staging'))).toEqual([]);
    await Promise.all(['one', 'two'].map(name => new ArtifactStore({ repoRoot }).writeArtifact(`.artifacts/runs/run/${name}.txt`, name)));
    for (const name of ['one', 'two']) expect(await readFile(path.join(repoRoot, `.artifacts/runs/run/${name}.txt`), 'utf8')).toBe(name);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});
