import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createRunManifest, type DeterministicSettings } from '@probefn/contracts';
import { createCheckpoint, ReportService, SessionManager } from '@probefn/core';
import { ArtifactStore } from '@probefn/storage';

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
  networkIdleMs: 250,
};

beforeAll(async () => {
  await Promise.all([
    removeRun('run_console_error', 'sess_console_error'),
    removeRun('run_unknown_failure', 'sess_unknown_failure'),
    removeRun('run_trace', 'sess_trace'),
    removeRun('run_trace_missing', 'sess_trace_missing'),
  ]);

  await seedSession({
    sessionId: 'sess_console_error',
    runId: 'run_console_error',
    url: 'http://127.0.0.1:4301/checkout',
    checkpointName: 'after-submit',
    checkpointIdNow: '2026-04-16T04:40:00Z',
    includeTrace: true,
    actionEvents: [
      {
        ts: '2026-04-16T04:40:01Z',
        source: 'framework',
        type: 'action',
        action: 'click',
        query: 'Submit order',
        targetElementId: 'el_submit_order_button',
        pageUrl: 'http://127.0.0.1:4301/checkout',
      },
    ],
    consoleEvents: [
      {
        ts: '2026-04-16T04:40:02Z',
        source: 'browser',
        type: 'console',
        level: 'error',
        text: 'TypeError: Cannot read properties of undefined (reading \"plan\")',
        pageUrl: 'http://127.0.0.1:4301/checkout',
      },
    ],
    networkEvents: [
      {
        ts: '2026-04-16T04:40:03Z',
        source: 'browser',
        type: 'response-failure',
        url: 'http://127.0.0.1:4301/api/orders/submit',
        method: 'POST',
        status: 500,
        statusText: 'Internal Server Error',
        resourceType: 'fetch',
        pageUrl: 'http://127.0.0.1:4301/checkout',
      },
    ],
  });

  await seedSession({
    sessionId: 'sess_unknown_failure',
    runId: 'run_unknown_failure',
    url: 'http://127.0.0.1:4302/unknown',
    checkpointName: 'unknown',
    checkpointIdNow: '2026-04-16T04:41:00Z',
    includeTrace: true,
    devServerStdoutEvents: [
      {
        ts: '2026-04-16T04:41:01Z',
        source: 'dev-server',
        stream: 'stdout',
        line: 'ready in 12 ms',
      },
    ],
  });

  await seedSession({
    sessionId: 'sess_trace',
    runId: 'run_trace',
    url: 'http://127.0.0.1:4303/trace',
    checkpointName: 'trace',
    checkpointIdNow: '2026-04-16T04:42:00Z',
    includeTrace: true,
  });

  await seedSession({
    sessionId: 'sess_trace_missing',
    runId: 'run_trace_missing',
    url: 'http://127.0.0.1:4304/trace-missing',
    checkpointName: 'trace-missing',
    checkpointIdNow: '2026-04-16T04:43:00Z',
    includeTrace: false,
    missingTraceReference: true,
  });
});

describe('session reporter', () => {
  it('exports a JSON report with evidence-backed hypotheses and artifact links', async () => {
    const sessionManager = createSessionManager();
    const exported = await sessionManager.exportReport({
      sessionId: 'sess_console_error',
      format: 'json',
    });

    expect(exported.reportPath).toBe('.artifacts/runs/run_console_error/report.json');
    expect(exported.tracePath).toBe('.artifacts/runs/run_console_error/browser.trace.zip');
    expect(exported.warnings).toEqual([]);
    expect(exported.reportData.hypotheses).toEqual([
      expect.objectContaining({
        hypothesisId: 'rh_submit_plan',
        confidence: 0.9,
        statement: 'The submit handler reads a missing plan object after the order form submit.',
        evidenceEventIds: ['evt_console_1', 'evt_network_1'],
      }),
    ]);
    expect(exported.reportData.unresolvedReason).toBeUndefined();
    expect(exported.reportData.tracePath).toBe('.artifacts/runs/run_console_error/browser.trace.zip');
    expect(exported.reportData.checkpointIndex).toEqual([
      expect.objectContaining({
        checkpointId: 'chk_after-submit',
      }),
    ]);
  });

  it('exports an unresolved JSON report instead of fabricating a root cause', async () => {
    const sessionManager = createSessionManager();
    const exported = await sessionManager.exportReport({
      sessionId: 'sess_unknown_failure',
      format: 'json',
    });

    expect(exported.reportPath).toBe('.artifacts/runs/run_unknown_failure/report.json');
    expect(exported.warnings).toEqual([]);
    expect(exported.reportData.hypotheses).toEqual([]);
    expect(exported.reportData.unresolvedReason).toBe('Insufficient evidence to assert a root cause.');
  });

  it('exports a markdown report with repository-relative artifact references', async () => {
    const sessionManager = createSessionManager();
    const exported = await sessionManager.exportReport({
      sessionId: 'sess_trace',
      format: 'markdown',
    });

    expect(exported.reportPath).toBe('.artifacts/runs/run_trace/report.md');
    expect(exported.includes).toEqual([
      'runMetadata',
      'checkpointIndex',
      'findings',
      'regressions',
      'hypotheses',
      'artifactReferences',
    ]);
    expect(exported.warnings).toEqual([]);
  });

  it('reports missing trace artifacts explicitly', async () => {
    const sessionManager = createSessionManager();
    const exported = await sessionManager.exportReport({
      sessionId: 'sess_trace_missing',
      format: 'json',
    });

    expect(exported.reportPath).toBe('.artifacts/runs/run_trace_missing/report.json');
    expect(exported.tracePath).toBeNull();
    expect(exported.warnings).toEqual([
      'Trace artifact was not recorded for this run.',
    ]);
  });
});

it('artifact-only export preserves checkpoint/analyzer metadata and trace behavior', async () => {
  const manager = createSessionManager();
  const service = new ReportService({ repoRoot: projectRoot, artifactStore: new ArtifactStore({ repoRoot: projectRoot }) });
  for (const sessionId of ['sess_console_error', 'sess_unknown_failure', 'sess_trace', 'sess_trace_missing']) {
    const session = await manager.read(sessionId);
    for (const format of ['json', 'markdown'] as const) {
      const full = await service.exportReport({ session, format });
      const before = await readFile(path.join(projectRoot, full.reportPath), 'utf8');
      const streamed = await service.exportReportArtifact({ session, format });
      const after = await readFile(path.join(projectRoot, streamed.reportPath), 'utf8');
      expect(format === 'json' ? JSON.parse(after) : after).toEqual(format === 'json' ? JSON.parse(before) : before);
      const { reportData: _data, ...metadata } = full;
      expect(streamed).toEqual(metadata);
    }
  }
});

function createSessionManager(): SessionManager {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });

  return new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
}

async function seedSession(input: {
  sessionId: string;
  runId: string;
  url: string;
  checkpointName: string;
  checkpointIdNow: string;
  includeTrace: boolean;
  missingTraceReference?: boolean;
  actionEvents?: Record<string, unknown>[];
  consoleEvents?: Record<string, unknown>[];
  pageErrorEvents?: Record<string, unknown>[];
  networkEvents?: Record<string, unknown>[];
  devServerStdoutEvents?: Record<string, unknown>[];
  devServerStderrEvents?: Record<string, unknown>[];
}): Promise<void> {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });
  const sessionManager = new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const runPaths = artifactStore.getRunPaths(input.runId);

  if (input.includeTrace) {
    await artifactStore.writeArtifact(runPaths.tracePath, Buffer.from(`trace:${input.runId}`));
  }

  await artifactStore.writeRunManifest(
    input.runId,
    createRunManifest({
      sessionId: input.sessionId,
      runId: input.runId,
      mode: 'debug',
      browser: 'chromium',
      artifactRoot: runPaths.runRoot,
      startedAt: input.checkpointIdNow,
      endedAt: input.checkpointIdNow,
      status: 'completed',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        url: input.url,
        resolvedUrl: input.url,
        readyPattern: 'Local:',
      },
    }),
  );

  await sessionManager.initialize({
    sessionId: input.sessionId,
    runId: input.runId,
    mode: 'debug',
    browser: 'chromium',
    deterministic,
    artifactRoot: runPaths.runRoot,
    startedAt: input.checkpointIdNow,
    manifestPath: runPaths.sessionManifestPath,
    resolvedUrl: input.url,
    artifacts: {
      tracePath: input.includeTrace
        ? runPaths.tracePath
        : input.missingTraceReference
          ? runPaths.tracePath
          : null,
      consoleSinkPath: runPaths.eventRoot + '/console.ndjson',
      pageErrorSinkPath: runPaths.eventRoot + '/page-errors.ndjson',
      networkSinkPath: runPaths.eventRoot + '/network.ndjson',
      devServerStdoutSinkPath: runPaths.devServerRoot + '/stdout.ndjson',
      devServerStderrSinkPath: runPaths.devServerRoot + '/stderr.ndjson',
    },
  });

  await writeEvents(
    artifactStore,
    path.posix.join(runPaths.eventRoot, 'actions.ndjson'),
    input.actionEvents ?? [],
  );
  await writeEvents(
    artifactStore,
    path.posix.join(runPaths.eventRoot, 'console.ndjson'),
    input.consoleEvents ?? [],
  );
  await writeEvents(
    artifactStore,
    path.posix.join(runPaths.eventRoot, 'page-errors.ndjson'),
    input.pageErrorEvents ?? [],
  );
  await writeEvents(
    artifactStore,
    path.posix.join(runPaths.eventRoot, 'network.ndjson'),
    input.networkEvents ?? [],
  );
  await writeEvents(
    artifactStore,
    path.posix.join(runPaths.devServerRoot, 'stdout.ndjson'),
    input.devServerStdoutEvents ?? [],
  );
  await writeEvents(
    artifactStore,
    path.posix.join(runPaths.devServerRoot, 'stderr.ndjson'),
    input.devServerStderrEvents ?? [],
  );

  await createCheckpoint({
    repoRoot: projectRoot,
    artifactStore,
    sessionId: input.sessionId,
    runId: input.runId,
    browser: 'chromium',
    name: input.checkpointName,
    delta: {
      newConsoleErrors: 0,
      newPageErrors: 0,
      newNetworkFailures: 0,
    },
    includeStyles: true,
    includeTrace: input.includeTrace,
    tracePath: input.includeTrace ? runPaths.tracePath : null,
    source: {
      url: () => input.url,
      viewportSize: () => deterministic.viewport,
      screenshot: async () => Buffer.from(`png:${input.runId}`),
      domSnapshot: async () => ({ html: `<main data-run="${input.runId}">ok</main>` }),
      accessibilitySnapshot: async () => ({ snapshot: `- main "${input.runId}"` }),
      layoutSnapshot: async () => ({
        url: input.url,
        elements: [
          {
            elementId: 'el_submit_order_button',
            role: 'button',
            name: 'Submit order',
            text: 'Submit order',
            visible: true,
            disabled: false,
            bounds: { x: 24, y: 96, width: 180, height: 56 },
            selectorHints: {
              id: 'submit-order',
              testId: 'submit-order',
              role: 'button',
              name: 'Submit order',
            },
          },
        ],
      }),
      stylesSnapshot: async () => ({
        elements: [
          {
            role: 'button',
            name: 'Submit order',
            text: 'Submit order',
            id: 'submit-order',
            testId: 'submit-order',
            visible: true,
            bounds: { x: 24, y: 96, width: 180, height: 56 },
            clientWidth: 180,
            clientHeight: 56,
            scrollWidth: 180,
            scrollHeight: 56,
            color: 'rgb(255, 255, 255)',
            backgroundColor: 'rgb(0, 68, 204)',
            outlineStyle: 'solid',
            outlineWidth: '2px',
            outlineColor: 'rgb(10, 102, 255)',
            boxShadow: '0 0 0 3px rgb(10, 102, 255)',
            borderColor: 'rgb(0, 68, 204)',
            borderWidth: '0px',
            fontSize: '18px',
            lineHeight: '24px',
            whiteSpace: 'normal',
            overflowX: 'visible',
            overflowY: 'visible',
            textOverflow: 'clip',
            focusable: true,
            focusIndicatorVisible: true,
          },
        ],
      }),
    },
    now: () => input.checkpointIdNow,
  });

  await sessionManager.markCompleted(input.sessionId, {
    endedAt: input.checkpointIdNow,
    artifacts: {
      tracePath: input.includeTrace
        ? runPaths.tracePath
        : input.missingTraceReference
          ? runPaths.tracePath
          : null,
    },
  });
}

async function writeEvents(
  artifactStore: ArtifactStore,
  relativePath: string,
  events: Record<string, unknown>[],
): Promise<void> {
  if (events.length === 0) {
    await artifactStore.writeArtifact(relativePath, '');
    return;
  }

  await artifactStore.writeArtifact(
    relativePath,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
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
  await mkdir(path.resolve(projectRoot, '.artifacts', 'session-state'), { recursive: true });
}
