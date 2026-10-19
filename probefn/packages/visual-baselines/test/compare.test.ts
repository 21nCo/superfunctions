import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { BrowserRunner, captureLayoutMetadata, captureStylesMetadata } from '@probefn/browser-runner';
import type { DeterministicSettings } from '@probefn/contracts/config';
import { isProbefnError } from '@probefn/contracts/errors';
import { captureEventDeltaBaseline, createCheckpoint, diffEventDeltaSummary, SessionManager } from '@probefn/core';
import { DevServerManager } from '@probefn/dev-server';
import { ArtifactStore } from '@probefn/storage';

import { compareBaseline, recordBaseline } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const desktopDeterministic: DeterministicSettings = {
  enabled: true,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  animationPolicy: 'freeze',
  networkIdleMs: 250,
};

const mobileDeterministic: DeterministicSettings = {
  ...desktopDeterministic,
  viewport: { width: 390, height: 844 },
};

beforeAll(async () => {
  await Promise.all([
    rm(path.resolve(projectRoot, '.artifacts', 'baselines'), { recursive: true, force: true }),
    removeRun('run_baseline_healthy', 'sess_healthy'),
    removeRun('run_mobile_reference', 'sess_mobile_reference'),
    removeRun('run_regression', 'sess_regression'),
  ]);

  await seedRun({
    sessionId: 'sess_healthy',
    runId: 'run_baseline_healthy',
    command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 4211`,
    url: 'http://127.0.0.1:4211',
    deterministic: desktopDeterministic,
    checkpointName: 'landing',
  });

  const mobileReference = await seedRun({
    sessionId: 'sess_mobile_reference',
    runId: 'run_mobile_reference',
    command: `${process.execPath} test/fixtures/vite-regression/server.mjs --port 4212 --variant baseline`,
    url: 'http://127.0.0.1:4212',
    deterministic: mobileDeterministic,
    checkpointName: 'mobile',
  });

  await recordBaseline({
    repoRoot: projectRoot,
    artifactRoot: mobileReference.artifactRoot,
    checkpointId: 'chk_mobile',
    baselineKey: 'home.mobile.chromium.light.390x844.utc',
    sessionId: 'sess_mobile_reference',
    runId: 'run_mobile_reference',
    deterministic: mobileDeterministic,
    now: () => '2026-04-16T04:30:00Z',
  });

  await seedRun({
    sessionId: 'sess_regression',
    runId: 'run_regression',
    command: `${process.execPath} test/fixtures/vite-regression/server.mjs --port 4213 --variant regression`,
    url: 'http://127.0.0.1:4213',
    deterministic: mobileDeterministic,
    checkpointName: 'mobile',
  });
});

describe.sequential('baseline comparison', () => {
  it('records and compares a matching desktop baseline without regressions', async () => {
    const result = await recordBaseline({
      repoRoot: projectRoot,
      artifactRoot: '.artifacts/runs/run_baseline_healthy',
      checkpointId: 'chk_landing',
      baselineKey: 'home.desktop.chromium.light.1440x900.utc',
      sessionId: 'sess_healthy',
      runId: 'run_baseline_healthy',
      deterministic: desktopDeterministic,
      now: () => '2026-04-16T04:31:00Z',
    });

    expect(result).toEqual({
      baselineKey: 'home.desktop.chromium.light.1440x900.utc',
      registryPath: '.artifacts/baselines/registry.json',
      sourceCheckpointId: 'chk_landing',
      warnings: [],
    });

    const comparison = await compareBaseline({
      repoRoot: projectRoot,
      artifactRoot: '.artifacts/runs/run_baseline_healthy',
      checkpointId: 'chk_landing',
      baselineKey: 'home.desktop.chromium.light.1440x900.utc',
      runId: 'run_baseline_healthy',
    });

    expect(comparison).toEqual({
      baselineKey: 'home.desktop.chromium.light.1440x900.utc',
      status: 'pass',
      pixelDiffPercent: 0,
      findings: [],
    });
  });

  it('reports a critical missing-element regression for the broken mobile checkpoint', async () => {
    const comparison = await compareBaseline({
      repoRoot: projectRoot,
      artifactRoot: '.artifacts/runs/run_regression',
      checkpointId: 'chk_mobile',
      baselineKey: 'home.mobile.chromium.light.390x844.utc',
      runId: 'run_regression',
    });

    expect(comparison.status).toBe('fail');
    expect(comparison.pixelDiffPercent).toBeGreaterThan(0);
    expect(comparison.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        findingId: 'rf_missing_cta',
        severity: 'critical',
        category: 'missing-element',
        summary: 'Primary CTA is absent in the current checkpoint but present in the baseline.',
      }),
    ]));

    const diffManifest = JSON.parse(
      await readFile(
        path.resolve(
          projectRoot,
          '.artifacts/runs/run_regression/diffs/home.mobile.chromium.light.390x844.utc/diff.json',
        ),
        'utf8',
      ),
    );
    expect(diffManifest.pixelDiffPercent).toBeGreaterThan(0);
  });

  it('returns a missing-baseline error for unknown keys', async () => {
    try {
      await compareBaseline({
        repoRoot: projectRoot,
        artifactRoot: '.artifacts/runs/run_regression',
        checkpointId: 'chk_mobile',
        baselineKey: 'missing.mobile.chromium.light.390x844.utc',
        runId: 'run_regression',
      });
      throw new Error('Expected missing baseline to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_BASELINE_NOT_FOUND',
        message: 'Baseline missing.mobile.chromium.light.390x844.utc was not found.',
      });
    }
  });

  it('returns a mismatch error when the baseline dimensions do not match the checkpoint', async () => {
    try {
      await compareBaseline({
        repoRoot: projectRoot,
        artifactRoot: '.artifacts/runs/run_regression',
        checkpointId: 'chk_mobile',
        baselineKey: 'home.desktop.chromium.light.1440x900.utc',
        runId: 'run_regression',
      });
      throw new Error('Expected mismatched dimensions to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_BASELINE_MISMATCH',
        message: 'Baseline dimensions do not match the checkpoint dimensions.',
      });
    }
  });
});

async function seedRun(input: {
  sessionId: string;
  runId: string;
  command: string;
  url: string;
  deterministic: DeterministicSettings;
  checkpointName: string;
}): Promise<{ artifactRoot: string }> {
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
    sessionId: input.sessionId,
    runId: input.runId,
    mode: 'visual-regression',
    browser: 'chromium',
    deterministic: input.deterministic,
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

  await sessionManager.initialize({
    sessionId: input.sessionId,
    runId: input.runId,
    mode: 'visual-regression',
    browser: 'chromium',
    deterministic: input.deterministic,
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
    sessionId: input.sessionId,
    runId: input.runId,
    browser: 'chromium',
    deterministic: input.deterministic,
    initialUrl: startedServer.resolvedUrl,
    trace: {
      enabled: false,
    },
  });

  await sessionManager.markRunning(input.sessionId, {
    artifacts: {
      consoleSinkPath: startedBrowser.sinkPaths.consoleSinkPath,
      pageErrorSinkPath: startedBrowser.sinkPaths.pageErrorSinkPath,
      networkSinkPath: startedBrowser.sinkPaths.networkSinkPath,
    },
  });

  const before = await captureEventDeltaBaseline(projectRoot, startedBrowser.sinkPaths);
  await createCheckpoint({
    repoRoot: projectRoot,
    artifactStore,
    sessionId: input.sessionId,
    runId: input.runId,
    browser: 'chromium',
    name: input.checkpointName,
    includeStyles: true,
    includeTrace: false,
    tracePath: null,
    delta: diffEventDeltaSummary(
      before,
      await captureEventDeltaBaseline(projectRoot, startedBrowser.sinkPaths),
    ),
    source: {
      url: () => startedBrowser.page.url(),
      viewportSize: () => startedBrowser.page.viewportSize() ?? { width: 0, height: 0 },
      screenshot: async () => startedBrowser.page.screenshot({ fullPage: true }),
      domSnapshot: async () => ({ html: await startedBrowser.page.content() }),
      accessibilitySnapshot: async () => ({
        snapshot: await startedBrowser.page.locator('body').ariaSnapshot(),
      }),
      layoutSnapshot: async () => captureLayoutMetadata(startedBrowser.page),
      stylesSnapshot: async () => captureStylesMetadata(startedBrowser.page),
    },
  });

  const closedBrowser = await browserRunner.stopSession(input.sessionId);
  await sessionManager.markCompleted(input.sessionId, {
    artifacts: {
      tracePath: closedBrowser.tracePath,
    },
  });
  await devServerManager.stopSession(input.sessionId);

  return {
    artifactRoot: startedServer.artifactRoot,
  };
}

async function removeRun(runId: string, sessionId: string): Promise<void> {
  await Promise.all([
    rm(path.resolve(projectRoot, '.artifacts', 'runs', runId), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(projectRoot, '.artifacts', 'session-state', `${sessionId}.json`), {
      recursive: true,
      force: true,
    }),
  ]);
}
