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
import { resolveSemanticTarget } from '../src/semantic-find.js';

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
  await rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_ambiguous'), {
    recursive: true,
    force: true,
  });
  await rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_ambiguous.json'), {
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

describe.sequential('semantic navigation', () => {
  it('resolves and acts on a unique semantic query without vision assistance', async () => {
    const context = await createEphemeralContext({
      port: '4186',
      sessionId: 'sess_semantic_unique',
      runId: 'run_semantic_unique',
      command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 4186`,
      url: 'http://127.0.0.1:4186',
    });

    try {
      const resolvedTarget = await resolveSemanticTarget(
        context.startedBrowser.page,
        'Save button',
      );
      expect(resolvedTarget.element.elementId).toBe('el_save_button');
      expect(resolvedTarget.element.selectorHints).toMatchObject({
        id: 'save-button',
        role: 'button',
      });

      const actionResult = await performPageAction({
        repoRoot: projectRoot,
        page: context.startedBrowser.page,
        action: {
          kind: 'click',
          target: {
            query: 'Save button',
          },
        },
        eventPaths: context.startedBrowser.sinkPaths,
      });

      expect(actionResult).toEqual({
        action: 'click',
        targetElementId: 'el_save_button',
        checkpointId: null,
        usedVisionAssist: false,
        newConsoleErrors: 0,
        newPageErrors: 0,
        newNetworkFailures: 0,
      });
    } finally {
      await context.browserRunner.stopSession('sess_semantic_unique');
      await context.devServerManager.stopSession('sess_semantic_unique');
    }
  });

  it('returns ambiguity details for multiple structurally valid semantic matches and persists sess_ambiguous', async () => {
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
      sessionId: 'sess_ambiguous',
      runId: 'run_ambiguous',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        command: `${process.execPath} test/fixtures/vite-ambiguous/server.mjs --port 4184`,
        cwd: '.',
        url: 'http://127.0.0.1:4184',
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
        timeoutMs: 5000,
        envAllowlist: [],
      },
    });

    await sessionManager.initialize({
      sessionId: 'sess_ambiguous',
      runId: 'run_ambiguous',
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
      sessionId: 'sess_ambiguous',
      runId: 'run_ambiguous',
      browser: 'chromium',
      deterministic,
      initialUrl: startedServer.resolvedUrl,
      trace: {
        enabled: false,
      },
    });

    await sessionManager.markRunning('sess_ambiguous', {
      artifacts: {
        consoleSinkPath: startedBrowser.sinkPaths.consoleSinkPath,
        pageErrorSinkPath: startedBrowser.sinkPaths.pageErrorSinkPath,
        networkSinkPath: startedBrowser.sinkPaths.networkSinkPath,
      },
    });

    try {
      await resolveSemanticTarget(startedBrowser.page, 'Primary CTA');
      throw new Error('Expected ambiguous semantic query to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_ACTION_AMBIGUOUS',
        message: 'Multiple interactable elements matched the provided query.',
        retryable: true,
        details: {
          query: 'Primary CTA',
          candidateCount: 2,
        },
      });
    } finally {
      const closedBrowser = await browserRunner.stopSession('sess_ambiguous');
      await sessionManager.markCompleted('sess_ambiguous', {
        artifacts: {
          tracePath: closedBrowser.tracePath,
        },
      });
      await devServerManager.stopSession('sess_ambiguous');
    }
  });

  it('returns target-not-found for unmatched semantic queries', async () => {
    const context = await createEphemeralContext({
      port: '4187',
      sessionId: 'sess_semantic_missing',
      runId: 'run_semantic_missing',
      command: `${process.execPath} test/fixtures/vite-ambiguous/server.mjs --port 4187`,
      url: 'http://127.0.0.1:4187',
    });

    try {
      await resolveSemanticTarget(context.startedBrowser.page, 'Imaginary CTA');
      throw new Error('Expected unmatched semantic query to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_ACTION_TARGET_NOT_FOUND',
        message: 'No interactable element matched the provided query.',
      });
    } finally {
      await context.browserRunner.stopSession('sess_semantic_missing');
      await context.devServerManager.stopSession('sess_semantic_missing');
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-semantic-'));
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
