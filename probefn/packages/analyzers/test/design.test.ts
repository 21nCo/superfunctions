import { createServer } from 'node:net';
import { readFile, rm, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BrowserRunner, captureLayoutMetadata, captureStylesMetadata } from '@probefn/browser-runner';
import { isProbefnError } from '@probefn/contracts/errors';
import type { DeterministicSettings } from '@probefn/contracts/config';
import { captureEventDeltaBaseline, createCheckpoint, diffEventDeltaSummary, SessionManager } from '@probefn/core';
import { DevServerManager } from '@probefn/dev-server';
import { ArtifactStore } from '@probefn/storage';

import {
  DESIGN_SEVERITY_POLICY,
  auditDesignBundle,
  loadCheckpointAuditBundle,
  type DesignAuditBundle,
  type DesignTokenMap,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureSource = path.resolve(__dirname, '../../../test/fixtures');
const projectRoot = await mkdtemp(path.join(tmpdir(), 'probe-design-fixture-'));
let setup: Promise<void> | undefined;
let closing = false;
let cleanupFailed = false;

const baseDeterministic: Omit<DeterministicSettings, 'viewport'> = {
  enabled: true,
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  animationPolicy: 'freeze',
  networkIdleMs: 250,
};

const mobileDeterministic: DeterministicSettings = {
  ...baseDeterministic,
  viewport: {
    width: 390,
    height: 844,
  },
};

const desktopDeterministic: DeterministicSettings = {
  ...baseDeterministic,
  viewport: {
    width: 1440,
    height: 900,
  },
};

const tokenMap: DesignTokenMap = {
  rules: [
    {
      findingId: 'df_token',
      severity: 'medium',
      summaryLabel: 'Primary button background',
      match: {
        id: 'primary-cta',
      },
      property: 'backgroundColor',
      expected: '#0044CC',
    },
  ],
};

const seededRuns: Partial<Record<'healthy' | 'overflow' | 'hmr' | 'tokenDrift' | 'noTokens', SeededRun>> = {};

beforeAll(() => {
  setup = (async () => {
  await cp(fixtureSource, path.join(projectRoot, 'test/fixtures'), { recursive: true });
  await Promise.all([
    removeSeed('run_design_healthy', 'sess_design_healthy'),
    removeSeed('run_overflow', 'sess_overflow'),
    removeSeed('run_hmr', 'sess_hmr'),
    removeSeed('run_token_drift', 'sess_token_drift'),
    removeSeed('run_no_tokens', 'sess_no_tokens'),
  ]);

  seededRuns.healthy = await seedFixtureRun({
    sessionId: 'sess_design_healthy',
    runId: 'run_design_healthy',
    command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 4201`,
    url: 'http://127.0.0.1:4201',
    deterministic: mobileDeterministic,
    checkpointName: 'mobile',
  });

  seededRuns.overflow = await seedFixtureRun({
    sessionId: 'sess_overflow',
    runId: 'run_overflow',
    command: `${process.execPath} test/fixtures/vite-overflow/server.mjs --port 4202`,
    url: 'http://127.0.0.1:4202',
    deterministic: mobileDeterministic,
    checkpointName: 'mobile',
  });

  seededRuns.hmr = await seedFixtureRun({
    sessionId: 'sess_hmr',
    runId: 'run_hmr',
    command: `${process.execPath} test/fixtures/vite-overflow/server.mjs --port 4203 --emit-hmr`,
    url: 'http://127.0.0.1:4203',
    deterministic: mobileDeterministic,
    checkpointName: 'mobile',
    waitMs: 250,
  });

  seededRuns.tokenDrift = await seedFixtureRun({
    sessionId: 'sess_token_drift',
    runId: 'run_token_drift',
    command: `${process.execPath} test/fixtures/vite-token-drift/server.mjs --port 4204`,
    url: 'http://127.0.0.1:4204',
    deterministic: desktopDeterministic,
    checkpointName: 'desktop',
  });

  seededRuns.noTokens = await seedFixtureRun({
    sessionId: 'sess_no_tokens',
    runId: 'run_no_tokens',
    command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 4205`,
    url: 'http://127.0.0.1:4205',
    deterministic: desktopDeterministic,
    checkpointName: 'desktop',
  });
  })();
  return setup;
});
afterAll(async () => {
  closing = true;
  await setup?.catch(() => undefined);
  if (cleanupFailed) throw new Error(`Fixture cleanup incomplete; retained ${projectRoot}`);
  await rm(projectRoot, { recursive: true, force: true });
});

describe.sequential('design analyzers', () => {
  it('keeps the healthy fixture clean and exposes the documented severity policy', async () => {
    const bundle = await readBundle(seededRuns.healthy!);
    const result = auditDesignBundle(bundle);

    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(DESIGN_SEVERITY_POLICY).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'overflow' }),
      expect.objectContaining({ category: 'focus-state' }),
      expect.objectContaining({ category: 'touch-target' }),
    ]));
  });

  it('detects overflow, clipping, overlap, and responsive breakage on the broken mobile fixture', async () => {
    const bundle = await readBundle(seededRuns.overflow!);
    const result = auditDesignBundle(bundle);

    expect(result.warnings).toEqual([]);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        findingId: 'df_overflow',
        severity: 'high',
        category: 'overflow',
        summary: 'Pricing Grid overflows the viewport by 24px at 390px width.',
      }),
      expect.objectContaining({
        findingId: 'df_clip',
        severity: 'medium',
        category: 'clipping',
        summary: 'Secondary CTA label is clipped on the right edge.',
      }),
      expect.objectContaining({
        findingId: 'df_overlap',
        category: 'overlap',
      }),
      expect.objectContaining({
        findingId: 'df_responsive',
        category: 'responsive',
      }),
    ]));
  });

  it('marks unstable findings and emits a checkpoint instability warning after hot reload', async () => {
    const bundle = await readBundle(seededRuns.hmr!);
    const result = auditDesignBundle(bundle);

    expect(bundle.unstable).toBe(true);
    expect(result.warnings).toEqual([
      'Checkpoint chk_mobile was captured during dev-server instability.',
    ]);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        findingId: 'df_overflow',
        category: 'overflow',
        unstable: true,
      }),
    ]));
  });

  it('detects token drift, missing focus visibility, touch target issues, and contrast metadata', async () => {
    const bundle = await readBundle(seededRuns.tokenDrift!);
    const result = auditDesignBundle(bundle, {
      tokenMap,
    });

    expect(result.warnings).toEqual([]);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        findingId: 'df_token',
        severity: 'medium',
        category: 'token-drift',
        summary: 'Primary button background #1B5FFF deviates from configured token color #0044CC.',
      }),
      expect.objectContaining({
        findingId: 'df_focus',
        severity: 'medium',
        category: 'focus-state',
        summary: 'Focused CTA has no visible outline.',
      }),
      expect.objectContaining({
        findingId: 'df_touch',
        category: 'touch-target',
      }),
      expect.objectContaining({
        findingId: 'df_contrast',
        category: 'contrast-metadata',
      }),
    ]));
  });

  it('suppresses token drift when token config is absent and surfaces the documented warning only', async () => {
    const bundle = await readBundle(seededRuns.noTokens!);
    const result = auditDesignBundle(bundle, {
      warnOnMissingTokenMap: true,
    });

    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      'Token configuration unavailable; token-drift checks skipped.',
    ]);
  });

  it('detects spacing and alignment drift from structured layout metadata', () => {
    const syntheticBundle = createSyntheticBundle();
    const result = auditDesignBundle(syntheticBundle);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        findingId: 'df_spacing',
        category: 'spacing',
      }),
      expect.objectContaining({
        findingId: 'df_alignment',
        category: 'alignment',
      }),
    ]));
  });
});

interface SeedFixtureRunInput {
  sessionId: string;
  runId: string;
  command: string;
  url: string;
  deterministic: DeterministicSettings;
  checkpointName: string;
  waitMs?: number;
}

interface SeededRun {
  sessionId: string;
  runId: string;
  artifactRoot: string;
  checkpointId: string;
}

async function seedFixtureRun(input: SeedFixtureRunInput): Promise<SeededRun> {
  if (closing) throw new Error('Fixture setup was cancelled');
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  input = { ...input, command: input.command.replace(/--port \d+/, `--port ${port}`), url: `http://127.0.0.1:${port}` };
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

  try {
  const startedServer = await devServerManager.startSession({
    sessionId: input.sessionId,
    runId: input.runId,
    mode: 'design-review',
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
    mode: 'design-review',
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

  if (input.waitMs) {
    await delay(input.waitMs);
  }

  const before = await captureEventDeltaBaseline(projectRoot, startedBrowser.sinkPaths);
  const runManifest = await readJson<Record<string, unknown>>(
    path.resolve(projectRoot, startedServer.manifestPath),
  );

  const checkpoint = await createCheckpoint({
    repoRoot: projectRoot,
    artifactStore,
    sessionId: input.sessionId,
    runId: input.runId,
    browser: 'chromium',
    name: input.checkpointName,
    includeStyles: true,
    includeTrace: false,
    unstable: runManifest.unstable === true,
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
    sessionId: input.sessionId,
    runId: input.runId,
    artifactRoot: startedServer.artifactRoot,
    checkpointId: checkpoint.checkpointId,
  };
  } finally {
    try {
      try { if (browserRunner.hasSession(input.sessionId)) await browserRunner.stopSession(input.sessionId); }
      finally {
        try { await devServerManager.stopSession(input.sessionId); }
        catch (error) { if (!isProbefnError(error) || error.code !== 'E_SESSION_NOT_FOUND') throw error; }
      }
    } catch (error) { cleanupFailed = true; throw error; }
  }
}

async function readBundle(run: SeededRun) {
  return loadCheckpointAuditBundle({
    repoRoot: projectRoot,
    artifactRoot: run.artifactRoot,
    checkpointId: run.checkpointId,
  });
}

async function removeSeed(runId: string, sessionId: string): Promise<void> {
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

function createSyntheticBundle(): DesignAuditBundle {
  return {
    sessionId: 'sess_synthetic',
    checkpointId: 'chk_layout',
    checkpointPath: '.artifacts/runs/run_synthetic/checkpoints/layout/checkpoint.json',
    layoutPath: '.artifacts/runs/run_synthetic/checkpoints/layout/layout.json',
    viewport: {
      width: 1280,
      height: 900,
    },
    layout: {
      elements: [
        buttonElement('el_card_1', 'Card one', 12, 100, 160, 48),
        buttonElement('el_card_2', 'Card two', 30, 164, 160, 48),
        buttonElement('el_card_3', 'Card three', 44, 224, 160, 48),
        buttonElement('el_card_4', 'Card four', 52, 332, 160, 48),
      ],
    },
    styles: {
      elements: [
        styleElement('Card one', 12, 100, 160, 48),
        styleElement('Card two', 30, 164, 160, 48),
        styleElement('Card three', 44, 224, 160, 48),
        styleElement('Card four', 52, 332, 160, 48),
      ],
    },
    unstable: false,
  };
}

function buttonElement(
  elementId: string,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  return {
    elementId,
    role: 'button',
    name,
    text: name,
    visible: true,
    disabled: false,
    bounds: { x, y, width, height },
    selectorHints: {
      name,
      role: 'button',
    },
  };
}

function styleElement(
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  return {
    role: 'button',
    name,
    text: name,
    bounds: { x, y, width, height },
    clientWidth: width,
    clientHeight: height,
    scrollWidth: width,
    scrollHeight: height,
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgb(255, 255, 255)',
    outlineStyle: 'solid',
    outlineWidth: '2px',
    outlineColor: 'rgb(0, 0, 0)',
    boxShadow: 'none',
    borderColor: 'rgb(0, 0, 0)',
    borderWidth: '1px',
    fontSize: '16px',
    lineHeight: '24px',
    whiteSpace: 'normal',
    overflowX: 'visible',
    overflowY: 'visible',
    textOverflow: 'clip',
    focusable: true,
    focusIndicatorVisible: true,
    visible: true,
  };
}

async function readJson<T>(absolutePath: string): Promise<T> {
  return JSON.parse(await readFile(absolutePath, 'utf8')) as T;
}
