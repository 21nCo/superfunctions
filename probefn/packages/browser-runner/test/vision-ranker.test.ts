import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { DeterministicSettings } from '@probefn/contracts/config';
import { isProbefnError } from '@probefn/contracts/errors';
import { SessionManager } from '@probefn/core';
import { DevServerManager } from '@probefn/dev-server';
import { ArtifactStore } from '@probefn/storage';

import { performPageAction } from '../src/actions.js';
import { BrowserRunner } from '../src/browser-runner.js';
import { findSemanticCandidates } from '../src/semantic-find.js';
import { rankVisionCandidates } from '../src/vision-ranker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const deterministic: DeterministicSettings = {
  enabled: true,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  animationPolicy: 'freeze',
  networkIdleMs: 500,
};

const tempDirectories: string[] = [];

beforeAll(async () => {
  await rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_overlay'), {
    recursive: true,
    force: true,
  });
  await rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_overlay.json'), {
    recursive: true,
    force: true,
  });
});

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

describe.sequential('vision-assisted ranking', () => {
  it('ranks the central checkout target first and rejects it after DOM confirmation on sess_overlay', async () => {
    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
    });
    const devServerManager = new DevServerManager({
      repoRoot: projectRoot,
      artifactStore,
    });
    const browserRunner = new BrowserRunner({
      repoRoot: projectRoot,
      artifactStore,
    });
    const sessionManager = new SessionManager({
      repoRoot: projectRoot,
      artifactStore,
    });

    const startedServer = await devServerManager.startSession({
      sessionId: 'sess_overlay',
      runId: 'run_overlay',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        command: `${process.execPath} test/fixtures/vite-overlay/server.mjs --port 4185`,
        cwd: '.',
        url: 'http://127.0.0.1:4185',
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
        timeoutMs: 5000,
        envAllowlist: [],
      },
    });

    await sessionManager.initialize({
      sessionId: 'sess_overlay',
      runId: 'run_overlay',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      artifactRoot: startedServer.artifactRoot,
      startedAt: startedServer.startedAt,
      manifestPath: startedServer.manifestPath,
      resolvedUrl: startedServer.resolvedUrl,
      artifacts: {
        ...(startedServer.stdoutSinkPath ? { devServerStdoutSinkPath: startedServer.stdoutSinkPath } : {}),
        ...(startedServer.stderrSinkPath ? { devServerStderrSinkPath: startedServer.stderrSinkPath } : {}),
      },
    });

    const startedBrowser = await browserRunner.startSession({
      sessionId: 'sess_overlay',
      runId: 'run_overlay',
      browser: 'chromium',
      deterministic,
      initialUrl: startedServer.resolvedUrl,
      trace: {
        enabled: false,
      },
    });

    await sessionManager.markRunning('sess_overlay', {
      artifacts: {
        consoleSinkPath: startedBrowser.sinkPaths.consoleSinkPath,
        pageErrorSinkPath: startedBrowser.sinkPaths.pageErrorSinkPath,
        networkSinkPath: startedBrowser.sinkPaths.networkSinkPath,
      },
    });

    const semanticCandidates = await findSemanticCandidates(
      startedBrowser.page,
      'Checkout button',
    );
    expect(semanticCandidates).toHaveLength(2);

    const highestScore = semanticCandidates[0]?.semanticScore ?? 0;
    const rankedCandidates = await rankVisionCandidates(
      startedBrowser.page,
      'Checkout button',
      semanticCandidates.filter((candidate) => candidate.semanticScore === highestScore),
    );
    expect(rankedCandidates[0]?.candidate.element.selectorHints.id).toBe('checkout-primary');

    try {
      await performPageAction({
        repoRoot: projectRoot,
        page: startedBrowser.page,
        action: {
          kind: 'click',
          target: {
            query: 'Checkout button',
            requireDomConfirmation: true,
          },
        },
        eventPaths: startedBrowser.sinkPaths,
      });
      throw new Error('Expected overlay confirmation to reject the action.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_ACTION_NOT_INTERACTABLE',
        message: 'Matched element is not safely interactable after DOM confirmation.',
        retryable: true,
        details: {
          query: 'Checkout button',
          usedVisionAssist: true,
        },
      });
    } finally {
      const closedBrowser = await browserRunner.stopSession('sess_overlay');
      await sessionManager.markCompleted('sess_overlay', {
        artifacts: {
          tracePath: closedBrowser.tracePath,
        },
      });
      await devServerManager.stopSession('sess_overlay');
    }
  });

  it('rejects query actions that would need vision assistance without DOM confirmation', async () => {
    const context = await createEphemeralContext({
      port: '4188',
      sessionId: 'sess_overlay_nodom',
      runId: 'run_overlay_nodom',
      command: `${process.execPath} test/fixtures/vite-overlay/server.mjs --port 4188`,
      url: 'http://127.0.0.1:4188',
    });

    try {
      await performPageAction({
        repoRoot: projectRoot,
        page: context.startedBrowser.page,
        action: {
          kind: 'click',
          target: {
            query: 'Checkout button',
            requireDomConfirmation: false,
          },
        },
        eventPaths: context.startedBrowser.sinkPaths,
      });
      throw new Error('Expected vision-assisted action without DOM confirmation to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_CONFIG_INVALID',
        message: 'Vision-assisted actions must require DOM confirmation.',
      });
    } finally {
      await context.browserRunner.stopSession('sess_overlay_nodom');
      await context.devServerManager.stopSession('sess_overlay_nodom');
    }
  });
});

async function createEphemeralContext(input: {
  port: string;
  sessionId: string;
  runId: string;
  command: string;
  url: string;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-vision-'));
  tempDirectories.push(directory);
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
    artifactRoot: `.artifacts-tests/${path.basename(directory)}`,
  });
  const devServerManager = new DevServerManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const browserRunner = new BrowserRunner({
    repoRoot: projectRoot,
    artifactStore,
  });

  const startedServer = await devServerManager.startSession({
    sessionId: input.sessionId,
    runId: input.runId,
    mode: 'debug',
    browser: 'chromium',
    deterministic,
    devServer: {
      mode: 'spawn',
      name: 'web',
      command: input.command,
      cwd: '.',
      url: input.url,
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
      timeoutMs: 5000,
      envAllowlist: [],
    },
  });

  const startedBrowser = await browserRunner.startSession({
    sessionId: input.sessionId,
    runId: input.runId,
    browser: 'chromium',
    deterministic,
    initialUrl: startedServer.resolvedUrl,
    trace: {
      enabled: false,
    },
  });

  return {
    artifactStore,
    browserRunner,
    devServerManager,
    startedBrowser,
    startedServer,
  };
}
