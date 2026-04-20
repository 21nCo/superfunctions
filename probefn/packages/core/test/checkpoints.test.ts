import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isProbefnError } from '@probefn/contracts/errors';
import { ArtifactStore } from '@probefn/storage';

import { createCheckpoint } from '../src/checkpoints.js';
import { captureEventDeltaBaseline, diffEventDeltaSummary } from '../src/deltas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(path.resolve(projectRoot, '.artifacts-tests', path.basename(directory)), {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('checkpoints', () => {
  it('captures all required checkpoint artifacts and commits the manifest last', async () => {
    const artifactStore = await createArtifactStore();
    await artifactStore.writeArtifact(
      `${artifactStore.getArtifactRoot()}/runs/run_healthy/browser.trace.zip`,
      Buffer.from('trace'),
    );
    const result = await createCheckpoint({
      repoRoot: projectRoot,
      artifactStore,
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
      browser: 'chromium',
      name: 'landing',
      delta: {
        newConsoleErrors: 0,
        newPageErrors: 0,
        newNetworkFailures: 0,
      },
      includeStyles: true,
      includeTrace: true,
      tracePath: `${artifactStore.getArtifactRoot()}/runs/run_healthy/browser.trace.zip`,
      source: {
        url: () => 'http://127.0.0.1:4173/',
        viewportSize: () => ({ width: 1440, height: 900 }),
        screenshot: async () => Buffer.from('png'),
        domSnapshot: async () => ({ html: '<main>hello</main>' }),
        accessibilitySnapshot: async () => ({ snapshot: '- main "Healthy Fixture"' }),
        layoutSnapshot: async () => ({ elements: [{ elementId: 'el_save_button', role: 'button' }] }),
        stylesSnapshot: async () => ({ body: { color: 'rgb(0, 0, 0)' } }),
      },
      now: () => '2026-04-15T12:43:55Z',
    });

    expect(result).toMatchObject({
      checkpointId: 'chk_landing',
      artifacts: [
        `${artifactStore.getArtifactRoot()}/runs/run_healthy/checkpoints/landing/screenshot.png`,
        `${artifactStore.getArtifactRoot()}/runs/run_healthy/checkpoints/landing/dom.json`,
        `${artifactStore.getArtifactRoot()}/runs/run_healthy/checkpoints/landing/ax.json`,
        `${artifactStore.getArtifactRoot()}/runs/run_healthy/checkpoints/landing/layout.json`,
        `${artifactStore.getArtifactRoot()}/runs/run_healthy/checkpoints/landing/styles.json`,
        `${artifactStore.getArtifactRoot()}/runs/run_healthy/browser.trace.zip`,
      ],
      newConsoleErrors: 0,
      newPageErrors: 0,
      newNetworkFailures: 0,
    });

    const manifestContents = JSON.parse(
      await readFile(
        path.resolve(
          projectRoot,
          artifactStore.getArtifactRoot(),
          'runs/run_healthy/checkpoints/landing/checkpoint.json',
        ),
        'utf8',
      ),
    );
    expect(manifestContents.artifacts).toHaveLength(6);
    expect(manifestContents.browser).toBe('chromium');
  });

  it('fails atomically when a required artifact cannot be captured', async () => {
    const artifactStore = await createArtifactStore();

    try {
      await createCheckpoint({
        repoRoot: projectRoot,
        artifactStore,
        sessionId: 'sess_crash',
        runId: 'run_crash',
        browser: 'chromium',
        name: 'after-crash',
        delta: {
          newConsoleErrors: 0,
          newPageErrors: 0,
          newNetworkFailures: 0,
        },
        source: {
          url: () => 'http://127.0.0.1:4173/',
          viewportSize: () => ({ width: 1440, height: 900 }),
          screenshot: async () => Buffer.from('png'),
          domSnapshot: async () => ({ html: '<main>hello</main>' }),
          accessibilitySnapshot: async () => {
            throw new Error('boom');
          },
          layoutSnapshot: async () => ({ elements: [] }),
        },
      });
      throw new Error('Expected checkpoint capture to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_CHECKPOINT_CAPTURE_FAILED',
        message: 'Required checkpoint artifacts could not be captured.',
      });

      await expect(
        readFile(
          path.resolve(
            projectRoot,
            artifactStore.getArtifactRoot(),
            'runs/run_crash/checkpoints/after-crash/checkpoint.json',
          ),
          'utf8',
        ),
      ).rejects.toThrow();
    }
  });

  it('computes explicit delta summaries from append-only event sinks', async () => {
    const artifactStore = await createArtifactStore();
    const consoleSink = artifactStore.createEventSink('run_delta', 'console', 'events');
    const pageErrorSink = artifactStore.createEventSink('run_delta', 'page-errors', 'events');
    const networkSink = artifactStore.createEventSink('run_delta', 'network', 'events');

    const before = await captureEventDeltaBaseline(projectRoot, {
      consoleSinkPath: consoleSink.getCurrentRelativePath(),
      pageErrorSinkPath: pageErrorSink.getCurrentRelativePath(),
      networkSinkPath: networkSink.getCurrentRelativePath(),
    });

    await consoleSink.append({
      ts: '2026-04-15T12:43:55Z',
      source: 'browser',
      type: 'console',
      level: 'error',
      text: 'boom',
      pageUrl: 'http://127.0.0.1:4176/',
    });
    await networkSink.append({
      ts: '2026-04-15T12:43:56Z',
      source: 'browser',
      type: 'response-failure',
      status: 500,
      statusText: 'Internal Server Error',
      url: 'http://127.0.0.1:4176/api/fail',
      method: 'GET',
      resourceType: 'fetch',
      pageUrl: 'http://127.0.0.1:4176/',
    });

    const after = await captureEventDeltaBaseline(projectRoot, {
      consoleSinkPath: consoleSink.getCurrentRelativePath(),
      pageErrorSinkPath: pageErrorSink.getCurrentRelativePath(),
      networkSinkPath: networkSink.getCurrentRelativePath(),
    });

    expect(diffEventDeltaSummary(before, after)).toEqual({
      newConsoleErrors: 1,
      newPageErrors: 0,
      newNetworkFailures: 1,
    });
  });
});

async function createArtifactStore(): Promise<ArtifactStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-core-'));
  tempDirectories.push(directory);
  return new ArtifactStore({
    repoRoot: projectRoot,
    artifactRoot: `.artifacts-tests/${path.basename(directory)}`,
  });
}
