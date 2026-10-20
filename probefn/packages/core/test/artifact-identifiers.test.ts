import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { ArtifactStore } from '@probefn/storage';
import { SessionManager, AuthProfileStore } from '../src/index.js';
import { BrowserRunner } from '@probefn/browser-runner';
import { DevServerManager } from '@probefn/dev-server';

const deterministic = { enabled: true, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC',
  colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 10 };

it('rejects session traversal before reading or replacing repository files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-identifiers-'));
  try {
    const sentinel = '{"private":"unchanged"}\n';
    await writeFile(path.join(root, 'package.json'), sentinel);
    const store = new ArtifactStore({ repoRoot: root });
    const sessions = new SessionManager({ repoRoot: root, artifactStore: store });
    await expect(sessions.read('../../package')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    await expect(sessions.initialize({ sessionId: '../../package', runId: 'run', mode: 'debug', browser: 'chromium',
      deterministic, artifactRoot: '.artifacts/runs/run', startedAt: new Date().toISOString(), manifestPath: '.artifacts/runs/run/session.json' }))
      .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(sentinel);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['.', '..'])('rejects reserved dot identifier %s in run, checkpoint and auth paths', value => {
  const store = new ArtifactStore({ repoRoot: tmpdir() });
  expect(() => store.getRunPaths(value)).toThrow();
  expect(() => store.getCheckpointPaths('valid', value)).toThrow();
  expect(() => new AuthProfileStore({ repoRoot: tmpdir(), artifactStore: store }).getProfileStorageStatePath(value)).toThrow();
});

it('rejects invalid identifiers before browser launch', async () => {
  const launch = vi.spyOn(chromium, 'launch');
  try {
    const runner = new BrowserRunner({ repoRoot: tmpdir(), artifactStore: new ArtifactStore({ repoRoot: tmpdir() }) });
    await expect(runner.startSession({ sessionId: '../escape', runId: 'run', browser: 'chromium', deterministic }))
      .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    expect(launch).not.toHaveBeenCalled();
  } finally { launch.mockRestore(); }
});


it('rejects invalid dev-server identities before attach I/O', async () => {
  const request = vi.spyOn(globalThis, 'fetch');
  try {
    const manager = new DevServerManager({ repoRoot: tmpdir(), artifactStore: new ArtifactStore({ repoRoot: tmpdir() }) });
    await expect(manager.startSession({ sessionId: '../escape', runId: 'run', mode: 'debug', browser: 'chromium', deterministic,
      devServer: { mode: 'attach', name: 'fixture', url: 'http://127.0.0.1:1', timeoutMs: 100, envAllowlist: [] } }))
      .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});

it('rejects auth import paths outside the repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-auth-paths-'));
  try {
    const store = new ArtifactStore({ repoRoot: root });
    const profiles = new AuthProfileStore({ repoRoot: root, artifactStore: store });
    for (const sourceStorageStatePath of ['../outside.json', path.join(tmpdir(), 'outside.json')]) {
      await expect(profiles.saveProfileFromPath({ profileId: 'valid', sourceStorageStatePath }))
        .rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
