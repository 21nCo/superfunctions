import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createRunManifest } from '@probefn/contracts';
import type { DeterministicSettings } from '@probefn/contracts/config';
import { isProbefnError } from '@probefn/contracts/errors';
import { SessionManager } from '@probefn/core';
import { DevServerManager } from '@probefn/dev-server';
import { ArtifactStore } from '@probefn/storage';

import { BrowserRunner } from '../src/browser-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const tempDirectories: string[] = [];
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

describe.sequential('BrowserRunner', () => {
  beforeAll(async () => {
    await rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_trace'), {
      recursive: true,
      force: true,
    });
    await rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_trace.json'), {
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

  afterAll(async () => {
    await rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_console_error'), {
      recursive: true,
      force: true,
    });
    await rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_console_error.json'), {
      recursive: true,
      force: true,
    });
  });

  it('launches chromium, persists trace state, and exports a report linked to the trace', async () => {
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
      sessionId: 'sess_trace',
      runId: 'run_trace',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 0`,
        cwd: '.',
        url: 'http://127.0.0.1:0',
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
        timeoutMs: 5000,
        envAllowlist: [],
      },
    });

    await sessionManager.initialize({
      sessionId: 'sess_trace',
      runId: 'run_trace',
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
      sessionId: 'sess_trace',
      runId: 'run_trace',
      browser: 'chromium',
      deterministic,
      initialUrl: startedServer.resolvedUrl,
      trace: {
        enabled: true,
      },
    });

    await sessionManager.markRunning('sess_trace', {
      artifacts: {
        consoleSinkPath: startedBrowser.sinkPaths.consoleSinkPath,
        pageErrorSinkPath: startedBrowser.sinkPaths.pageErrorSinkPath,
        networkSinkPath: startedBrowser.sinkPaths.networkSinkPath,
      },
    });

    const closedBrowser = await browserRunner.stopSession('sess_trace');
    await sessionManager.markCompleted('sess_trace', {
      artifacts: {
        tracePath: closedBrowser.tracePath,
      },
    });
    await devServerManager.stopSession('sess_trace');

    const exportedReport = await sessionManager.exportReport({
      sessionId: 'sess_trace',
      format: 'json',
    });

    expect(exportedReport.tracePath).toBe('.artifacts/runs/run_trace/browser.trace.zip');
    expect(exportedReport.reportPath).toBe('.artifacts/runs/run_trace/report.json');
    await access(path.resolve(projectRoot, '.artifacts/runs/run_trace/browser.trace.zip'));

    const runManifest = JSON.parse(
      await readFile(path.resolve(projectRoot, '.artifacts/runs/run_trace/session.json'), 'utf8'),
    );
    const reportJson = JSON.parse(
      await readFile(path.resolve(projectRoot, '.artifacts/runs/run_trace/report.json'), 'utf8'),
    );

    expect(runManifest.browser).toBe('chromium');
    expect(reportJson.artifactReferences.tracePath).toBe('.artifacts/runs/run_trace/browser.trace.zip');
  });

  it('captures console, page-error, request-failed, and response-failure events as separate browser sinks', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'probefn-browser-runner-'));
    tempDirectories.push(tempDirectory);
    const port = await getAvailablePort();

    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
      artifactRoot: `.artifacts-tests/${path.basename(tempDirectory)}`,
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
      sessionId: 'sess_console_error',
      runId: 'run_console_error',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        command: `${process.execPath} test/fixtures/vite-console-error/server.mjs --port ${port}`,
        cwd: '.',
        url: `http://127.0.0.1:${port}`,
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
        timeoutMs: 5000,
        envAllowlist: [],
      },
    });

    const startedBrowser = await browserRunner.startSession({
      sessionId: 'sess_console_error',
      runId: 'run_console_error',
      browser: 'chromium',
      deterministic,
      initialUrl: startedServer.resolvedUrl,
      trace: {
        enabled: true,
      },
    });

    await startedBrowser.page.waitForTimeout(750);
    const closedBrowser = await browserRunner.stopSession('sess_console_error');
    await devServerManager.stopSession('sess_console_error');

    const consoleEvents = await readNdjson(
      path.resolve(projectRoot, startedBrowser.sinkPaths.consoleSinkPath),
    );
    const pageErrorEvents = await readNdjson(
      path.resolve(projectRoot, startedBrowser.sinkPaths.pageErrorSinkPath),
    );
    const networkEvents = await readNdjson(
      path.resolve(projectRoot, startedBrowser.sinkPaths.networkSinkPath),
    );

    expect(closedBrowser.tracePath).toBe(
      `${artifactStore.getArtifactRoot()}/runs/run_console_error/browser.trace.zip`,
    );
    expect(consoleEvents.some((event) => event.type === 'console' && event.level === 'error')).toBe(true);
    expect(pageErrorEvents.some((event) => event.type === 'page-error')).toBe(true);
    expect(networkEvents.some((event) => event.type === 'request-failed')).toBe(true);
    expect(networkEvents.some((event) => event.type === 'response-failure' && event.status === 500)).toBe(true);
  });

  it('reports missing trace artifacts explicitly instead of linking a non-existent file', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'probefn-browser-runner-'));
    tempDirectories.push(tempDirectory);
    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
      artifactRoot: `.artifacts-tests/${path.basename(tempDirectory)}`,
    });
    const sessionManager = new SessionManager({
      repoRoot: projectRoot,
      artifactStore,
    });
    const runPaths = artifactStore.getRunPaths('run_trace_missing');

    await artifactStore.writeRunManifest(
      'run_trace_missing',
      createRunManifest({
        sessionId: 'sess_trace_missing',
        runId: 'run_trace_missing',
        mode: 'debug',
        browser: 'chromium',
        artifactRoot: runPaths.runRoot,
        startedAt: '2026-04-15T12:43:55Z',
        endedAt: '2026-04-15T12:43:55Z',
        status: 'completed',
        deterministic,
        devServer: {
          mode: 'attach',
          name: 'trace-missing',
          url: 'http://127.0.0.1:4183/',
          resolvedUrl: 'http://127.0.0.1:4183/',
        },
      }),
    );

    await sessionManager.initialize({
      sessionId: 'sess_trace_missing',
      runId: 'run_trace_missing',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      artifactRoot: runPaths.runRoot,
      startedAt: '2026-04-15T12:43:55Z',
      manifestPath: runPaths.sessionManifestPath,
      resolvedUrl: 'http://127.0.0.1:4183/',
    });

    const exportedReport = await sessionManager.exportReport({
      sessionId: 'sess_trace_missing',
      format: 'json',
    });

    expect(exportedReport).toMatchObject({
      tracePath: null,
      reportPath: `${artifactStore.getArtifactRoot()}/runs/run_trace_missing/report.json`,
      warnings: ['Trace artifact was not recorded for this run.'],
    });
  });

  it('rejects unsupported browser engines before launch', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'probefn-browser-runner-'));
    tempDirectories.push(tempDirectory);
    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
      artifactRoot: `.artifacts-tests/${path.basename(tempDirectory)}`,
    });
    const browserRunner = new BrowserRunner({
      repoRoot: projectRoot,
      artifactStore,
    });

    try {
      await browserRunner.startSession({
        sessionId: 'sess_invalid_browser',
        runId: 'run_invalid_browser',
        browser: 'netscape' as never,
        deterministic,
      });
      throw new Error('Expected invalid browser engine to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_CONFIG_INVALID',
        message: 'Invalid browser engine "netscape".',
      });
    }
  });
});

async function readNdjson(absolutePath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(absolutePath, 'utf8');
  return JSON.parse(`[${contents.trim().split('\n').join(',')}]`) as Array<Record<string, unknown>>;
}

async function getAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
