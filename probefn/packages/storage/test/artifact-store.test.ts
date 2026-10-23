import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManifest } from '@probefn/contracts/manifests';
import { ArtifactStore } from '../src/artifact-store.js';

const tempDirectories: string[] = [];

async function createRepoRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-storage-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
    }),
  );
});

describe('ArtifactStore', () => {
  it('plans repository-relative run paths and writes grouped artifacts', async () => {
    const repoRoot = await createRepoRoot();
    const store = new ArtifactStore({
      repoRoot,
    });

    const runPaths = store.getRunPaths('run_healthy');
    const checkpointPaths = store.getCheckpointPaths('run_healthy', 'landing page');

    await store.writeRunManifest(
      'run_healthy',
      createRunManifest({
        sessionId: 'sess_healthy',
        runId: 'run_healthy',
        mode: 'mixed',
        browser: 'chromium',
        artifactRoot: runPaths.runRoot,
        startedAt: '2026-04-15T12:43:55Z',
        status: 'running',
        deterministic: {
          enabled: true,
          viewport: { width: 1440, height: 900 },
          locale: 'en-US',
          timezone: 'UTC',
          colorScheme: 'light',
          reducedMotion: 'reduce',
          animationPolicy: 'freeze',
          networkIdleMs: 500,
        },
      }),
    );
    await store.writeArtifact(checkpointPaths.domPath, '{"page":"ok"}\n');
    await store.writeReport('run_healthy', 'json', {
      reportPath: '.artifacts/runs/run_healthy/report.json',
      checkpointRoot: runPaths.checkpointRoot,
    });

    const manifestContents = await readFile(
      path.resolve(repoRoot, runPaths.sessionManifestPath),
      'utf8',
    );
    const reportContents = await readFile(
      path.resolve(repoRoot, runPaths.reportJsonPath),
      'utf8',
    );

    expect({
      runPaths,
      checkpointPaths,
      manifestContents: JSON.parse(manifestContents),
      reportContents: JSON.parse(reportContents),
    }).toMatchSnapshot();
  });
});
