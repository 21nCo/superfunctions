import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { ArtifactStore, SessionOwnership } from '@probefn/storage';
import { AuthProfileStore } from '../src/auth-profiles.js';

it('fences both auth-session imports and writes while preserving explicit owner access', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'probe-auth-writer-'));
  const artifactStore = new ArtifactStore({ repoRoot });
  const profiles = new AuthProfileStore({ repoRoot, artifactStore });
  const storageState = { cookies: [], origins: [] };
  await profiles.saveProfile({ profileId: 'profile', storageState });
  const owner = await SessionOwnership.acquire({ repoRoot, artifactRoot: '.artifacts', sessionId: 'session', runId: 'run' });
  try {
    await expect(profiles.initializeSessionStorageFromProfile({ profileId: 'profile', runId: 'run' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await expect(profiles.writeSessionStorageState({ runId: 'run', storageState })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await expect(readFile(path.join(repoRoot, profiles.getSessionStorageStatePath('run')))).rejects.toMatchObject({ code: 'ENOENT' });
    await owner.run(async () => {
      await profiles.initializeSessionStorageFromProfile({ profileId: 'profile', runId: 'run' });
      await profiles.writeSessionStorageState({ runId: 'run', storageState });
    });
    expect(JSON.parse(await readFile(path.join(repoRoot, profiles.getSessionStorageStatePath('run')), 'utf8'))).toEqual(storageState);
  } finally { owner.release(); await rm(repoRoot, { recursive: true, force: true }); }
});

it('charges imported and generated auth-session state to the persisted run cap', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'probe-auth-cap-'));
  const profiles = new AuthProfileStore({ repoRoot, artifactStore: new ArtifactStore({ repoRoot, caps: { maxArtifactBytes: 1 } }) });
  const storageState = { cookies: [], origins: [] };
  try {
    await profiles.saveProfile({ profileId: 'profile', storageState });
    await expect(profiles.initializeSessionStorageFromProfile({ profileId: 'profile', runId: 'run' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
    await expect(profiles.writeSessionStorageState({ runId: 'run', storageState })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
    await expect(readFile(path.join(repoRoot, profiles.getSessionStorageStatePath('run')))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});
