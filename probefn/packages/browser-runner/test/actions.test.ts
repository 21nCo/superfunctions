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

import { performDeterministicAction } from '../src/actions.js';
import { BrowserRunner } from '../src/browser-runner.js';
import { extractPageModel } from '../src/page-model.js';

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
  await rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_healthy'), {
    recursive: true,
    force: true,
  });
  await rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_healthy.json'), {
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

describe.sequential('deterministic actions', () => {
  it('extracts a page model and executes selector-first actions against the healthy fixture', async () => {
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
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 4173`,
        cwd: '.',
        url: 'http://127.0.0.1:4173',
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
        timeoutMs: 5000,
        envAllowlist: [],
      },
    });

    await sessionManager.initialize({
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
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
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
      browser: 'chromium',
      deterministic,
      initialUrl: startedServer.resolvedUrl,
      trace: {
        enabled: true,
      },
    });

    await sessionManager.markRunning('sess_healthy', {
      artifacts: {
        consoleSinkPath: startedBrowser.sinkPaths.consoleSinkPath,
        pageErrorSinkPath: startedBrowser.sinkPaths.pageErrorSinkPath,
        networkSinkPath: startedBrowser.sinkPaths.networkSinkPath,
      },
    });

    const pageModel = await extractPageModel(startedBrowser.page);
    expect(pageModel.elements.some((element) => element.elementId === 'el_save_button')).toBe(true);

    await performDeterministicAction({
      repoRoot: projectRoot,
      page: startedBrowser.page,
      action: {
        kind: 'fill',
        target: {
          selector: 'label=Project name',
        },
        value: 'Neptune',
      },
      eventPaths: startedBrowser.sinkPaths,
    });

    await performDeterministicAction({
      repoRoot: projectRoot,
      page: startedBrowser.page,
      action: {
        kind: 'select',
        target: {
          selector: 'label=Plan',
        },
        value: 'pro',
      },
      eventPaths: startedBrowser.sinkPaths,
    });

    await performDeterministicAction({
      repoRoot: projectRoot,
      page: startedBrowser.page,
      action: {
        kind: 'hover',
        target: {
          selector: '[data-testid="hover-card"]',
        },
      },
      eventPaths: startedBrowser.sinkPaths,
    });

    await performDeterministicAction({
      repoRoot: projectRoot,
      page: startedBrowser.page,
      action: {
        kind: 'press',
        target: {
          selector: 'label=Project name',
        },
        key: 'Enter',
      },
      eventPaths: startedBrowser.sinkPaths,
    });

    const clickResult = await performDeterministicAction({
      repoRoot: projectRoot,
      page: startedBrowser.page,
      action: {
        kind: 'click',
        target: {
          selector: 'role=button[name="Save"]',
        },
      },
      eventPaths: startedBrowser.sinkPaths,
    });

    expect(clickResult).toEqual({
      action: 'click',
      targetElementId: 'el_save_button',
      checkpointId: null,
      newConsoleErrors: 0,
      newPageErrors: 0,
      newNetworkFailures: 0,
    });

    const fixtureState = await startedBrowser.page.evaluate(
      () => (window as unknown as { __probefnFixtureState: unknown }).__probefnFixtureState,
    );
    expect(fixtureState).toMatchObject({
      clicked: 1,
      hovered: 1,
      lastKey: 'Enter',
      projectName: 'Neptune',
      plan: 'pro',
    });

    const closedBrowser = await browserRunner.stopSession('sess_healthy');
    await sessionManager.markCompleted('sess_healthy', {
      artifacts: {
        tracePath: closedBrowser.tracePath,
      },
    });
    await devServerManager.stopSession('sess_healthy');
  });

  it('returns target-not-found for unmatched explicit selectors', async () => {
    const context = await createEphemeralContext('4178', 'sess_not_found', 'run_not_found');

    try {
      await performDeterministicAction({
        repoRoot: projectRoot,
        page: context.startedBrowser.page,
        action: {
          kind: 'click',
          target: {
            selector: 'role=button[name="Does Not Exist"]',
          },
        },
        eventPaths: context.startedBrowser.sinkPaths,
      });
      throw new Error('Expected selector miss to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_ACTION_TARGET_NOT_FOUND',
        message: 'No element matched selector role=button[name="Does Not Exist"].',
      });
    } finally {
      await context.browserRunner.stopSession('sess_not_found');
      await context.devServerManager.stopSession('sess_not_found');
    }
  });

  it('returns not-interactable when a deterministic target exists but is disabled', async () => {
    const context = await createEphemeralContext('4179', 'sess_disabled', 'run_disabled');

    try {
      await performDeterministicAction({
        repoRoot: projectRoot,
        page: context.startedBrowser.page,
        action: {
          kind: 'click',
          target: {
            selector: 'role=button[name="Disabled Save"]',
          },
        },
        eventPaths: context.startedBrowser.sinkPaths,
      });
      throw new Error('Expected disabled target to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_ACTION_NOT_INTERACTABLE',
        message: 'Element matched selector role=button[name="Disabled Save"] but is not safely interactable.',
      });
    } finally {
      await context.browserRunner.stopSession('sess_disabled');
      await context.devServerManager.stopSession('sess_disabled');
    }
  });
});

async function createEphemeralContext(port: string, sessionId: string, runId: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-actions-'));
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
    sessionId,
    runId,
    mode: 'debug',
    browser: 'chromium',
    deterministic,
    devServer: {
      mode: 'spawn',
      name: 'web',
      command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port ${port}`,
      cwd: '.',
      url: `http://127.0.0.1:${port}`,
      readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
      timeoutMs: 5000,
      envAllowlist: [],
    },
  });

  const startedBrowser = await browserRunner.startSession({
    sessionId,
    runId,
    browser: 'chromium',
    deterministic,
    initialUrl: startedServer.resolvedUrl,
    trace: {
      enabled: false,
    },
  });

  return {
    artifactStore,
    devServerManager,
    browserRunner,
    startedServer,
    startedBrowser,
  };
}
