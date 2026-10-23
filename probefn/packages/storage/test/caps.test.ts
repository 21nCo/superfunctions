import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isProbefnError } from '@probefn/contracts/errors';
import { ArtifactStore } from '../src/artifact-store.js';
import { ArtifactCapTracker } from '../src/caps.js';
import { NdjsonEventSink } from '../src/event-sink.js';

const tempDirectories: string[] = [];

async function createRepoRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-caps-'));
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

describe('storage caps', () => {
  it('rolls over event sinks when event caps are reached', async () => {
    const repoRoot = await createRepoRoot();
    const sink = new NdjsonEventSink({
      repoRoot,
      relativeDirectory: '.artifacts/runs/run_spam/checkpoints/spam',
      baseName: 'console',
      capTracker: new ArtifactCapTracker(10_000),
      policy: {
        maxEventsPerSink: 3,
        strategy: 'rollover',
      },
    });

    await sink.append({ index: 1 });
    await sink.append({ index: 2 });
    await sink.append({ index: 3 });
    const result = await sink.append({ index: 4 });

    const rolledOverContents = await readFile(
      path.resolve(repoRoot, result.relativePath),
      'utf8',
    );

    expect({
      result,
      rolledOverContents,
    }).toMatchSnapshot();
  });

  it('fails explicitly when artifact caps are exceeded', async () => {
    const repoRoot = await createRepoRoot();
    const store = new ArtifactStore({
      repoRoot,
      caps: {
        maxArtifactBytes: 1,
      },
    });

    try {
      await store.writeArtifact('.artifacts/runs/run_spam/checkpoints/oversized/layout.json', 'too-big');
      throw new Error('Expected artifact cap enforcement to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_STORAGE_CAP_EXCEEDED',
        message:
          'Artifact cap exceeded before .artifacts/runs/run_spam/checkpoints/oversized/layout.json could be committed.',
      });
    }
  });
});
