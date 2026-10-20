import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { ProbefnRuntime, startSessionFromConfig } from '../src/server.js';

it.each(['sessionId', 'runId'] as const)('rejects invalid %s before config reads, auth copies or runtime scope creation', async field => {
  const runtime = new ProbefnRuntime(tmpdir());
  const root = vi.spyOn(runtime, 'getRepoRoot');
  const scope = vi.spyOn(runtime, 'createScope');
  try {
    await expect(startSessionFromConfig(runtime, { configPath: 'missing-preflight-fixture.json', authProfileId: 'valid', sessionId: 'valid-session', runId: 'valid-run', [field]: '../escape' }))
      .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    expect(root).not.toHaveBeenCalled(); expect(scope).not.toHaveBeenCalled();
  } finally { root.mockRestore(); scope.mockRestore(); }
});
