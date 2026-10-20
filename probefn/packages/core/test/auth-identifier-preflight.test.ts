import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { AuthProfileStore } from '../src/auth-profiles.js';

it('rejects a reserved profile identifier before accessing an import source', async () => {
  const profiles = new AuthProfileStore({ repoRoot: tmpdir(), artifactStore: new ArtifactStore({ repoRoot: tmpdir() }) });
  await expect(profiles.saveProfileFromPath({ profileId: '..', sourceStorageStatePath: 'missing-preflight-fixture/storage.json' }))
    .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED', message: 'Auth profile id must be a non-reserved path segment.' });
});

it('rejects an invalid destination run before reading an auth profile', async () => {
  const profiles = new AuthProfileStore({ repoRoot: tmpdir(), artifactStore: new ArtifactStore({ repoRoot: tmpdir() }) });
  const load = vi.spyOn(profiles, 'loadProfile');
  try {
    await expect(profiles.initializeSessionStorageFromProfile({ profileId: 'valid', runId: '../escape' }))
      .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED', message: 'Run id must be a non-reserved path segment.' });
    expect(load).not.toHaveBeenCalled();
  } finally { load.mockRestore(); }
});
