import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createRunManifest, type DeterministicSettings } from '@probefn/contracts';
import { createCheckpoint, SessionManager } from '@probefn/core';
import { ArtifactStore } from '@probefn/storage';

import { executeCli } from '../src/index.js';

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
    rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_healthy'), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_healthy.json'), {
      force: true,
    }),
    rm(path.resolve(projectRoot, '.artifacts', 'session-state', 'sess_missing.json'), {
      force: true,
    }),
  ]);

  await seedHealthySession();
});

describe.sequential('cli', () => {
  it('emits the canonical success envelope for page find', async () => {
    const result = await runCli([
      'page',
      'find',
      '--session',
      'sess_healthy',
      '--query',
      'Save button',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      schemaVersion: '1.0',
      data: {
        elements: [
          {
            elementId: 'el_save_button',
            role: 'button',
            name: 'Save',
          },
        ],
      },
      warnings: [],
    });
  });

  it('emits canonical validation errors to stderr', async () => {
    const result = await runCli([
      'page',
      'find',
      '--session',
      'sess_healthy',
      '--json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      schemaVersion: '1.0',
      error: {
        code: 'E_CONFIG_INVALID',
        message: 'Missing required --query flag.',
        retryable: false,
      },
    });
  });

  it('emits canonical session-not-found errors to stderr', async () => {
    const result = await runCli([
      'page',
      'find',
      '--session',
      'sess_missing',
      '--query',
      'Save button',
      '--json',
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      schemaVersion: '1.0',
      error: {
        code: 'E_SESSION_NOT_FOUND',
        message: 'Session sess_missing was not found.',
        retryable: false,
        details: {
          sessionId: 'sess_missing',
        },
      },
    });
  });

  it('rejects unsupported report formats before exporting', async () => {
    const result = await runCli([
      'report',
      'export',
      '--session',
      'sess_healthy',
      '--format',
      'html',
      '--json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      schemaVersion: '1.0',
      error: {
        code: 'E_CONFIG_INVALID',
        message: 'Unsupported report format html. Expected json or markdown.',
        retryable: false,
      },
    });
  });
});

async function seedHealthySession(): Promise<void> {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });
  const sessionManager = new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const runId = 'run_healthy';
  const sessionId = 'sess_healthy';
  const runPaths = artifactStore.getRunPaths(runId);
  const resolvedUrl = 'http://127.0.0.1:4173/';

  await artifactStore.writeRunManifest(
    runId,
    createRunManifest({
      sessionId,
      runId,
      mode: 'debug',
      browser: 'chromium',
      artifactRoot: runPaths.runRoot,
      startedAt: '2026-04-16T10:00:00Z',
      endedAt: '2026-04-16T10:00:00Z',
      status: 'completed',
      deterministic,
      devServer: {
        mode: 'attach',
        name: 'web',
        url: resolvedUrl,
        resolvedUrl,
      },
    }),
  );

  await sessionManager.initialize({
    sessionId,
    runId,
    mode: 'debug',
    browser: 'chromium',
    deterministic,
    artifactRoot: runPaths.runRoot,
    startedAt: '2026-04-16T10:00:00Z',
    manifestPath: runPaths.sessionManifestPath,
    resolvedUrl,
    artifacts: {
      consoleSinkPath: path.posix.join(runPaths.eventRoot, 'console.ndjson'),
      pageErrorSinkPath: path.posix.join(runPaths.eventRoot, 'page-errors.ndjson'),
      networkSinkPath: path.posix.join(runPaths.eventRoot, 'network.ndjson'),
      devServerStdoutSinkPath: path.posix.join(runPaths.devServerRoot, 'stdout.ndjson'),
      devServerStderrSinkPath: path.posix.join(runPaths.devServerRoot, 'stderr.ndjson'),
    },
  });

  await Promise.all([
    writeEvents(artifactStore, path.posix.join(runPaths.eventRoot, 'console.ndjson'), []),
    writeEvents(artifactStore, path.posix.join(runPaths.eventRoot, 'page-errors.ndjson'), []),
    writeEvents(artifactStore, path.posix.join(runPaths.eventRoot, 'network.ndjson'), []),
    writeEvents(artifactStore, path.posix.join(runPaths.devServerRoot, 'stdout.ndjson'), []),
    writeEvents(artifactStore, path.posix.join(runPaths.devServerRoot, 'stderr.ndjson'), []),
  ]);

  await createCheckpoint({
    repoRoot: projectRoot,
    artifactStore,
    sessionId,
    runId,
    browser: 'chromium',
    name: 'landing',
    delta: {
      newConsoleErrors: 0,
      newPageErrors: 0,
      newNetworkFailures: 0,
    },
    includeStyles: true,
    source: {
      url: () => resolvedUrl,
      viewportSize: () => deterministic.viewport,
      screenshot: async () => Buffer.from('png:run_healthy'),
      domSnapshot: async () => ({
        html: '<main><button id="save-button">Save</button></main>',
      }),
      accessibilitySnapshot: async () => ({
        snapshot: '- main "settings"',
      }),
      layoutSnapshot: async () => ({
        url: resolvedUrl,
        elements: [
          {
            elementId: 'el_save_button',
            role: 'button',
            name: 'Save',
            text: 'Save',
            visible: true,
            disabled: false,
            bounds: { x: 24, y: 120, width: 160, height: 44 },
            selectorHints: {
              id: 'save-button',
              role: 'button',
              name: 'Save',
            },
          },
        ],
      }),
      stylesSnapshot: async () => ({
        elements: [
          {
            elementId: 'el_save_button',
            computed: {
              color: 'rgb(255, 255, 255)',
              backgroundColor: 'rgb(14, 116, 144)',
            },
          },
        ],
      }),
    },
    now: () => '2026-04-16T10:00:00Z',
  });

  await sessionManager.markCompleted(sessionId, {
    endedAt: '2026-04-16T10:00:00Z',
  });
}

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdoutCapture = createCaptureStream();
  const stderrCapture = createCaptureStream();
  const exitCode = await executeCli(args, {
    repoRoot: projectRoot,
    io: {
      stdout: stdoutCapture.stream,
      stderr: stderrCapture.stream,
    },
  });

  return {
    exitCode,
    stdout: stdoutCapture.read(),
    stderr: stderrCapture.read(),
  };
}

function createCaptureStream(): {
  stream: Writable;
  read(): string;
} {
  let buffer = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
        callback();
      },
    }),
    read() {
      return buffer;
    },
  };
}

async function writeEvents(
  artifactStore: ArtifactStore,
  relativePath: string,
  events: Record<string, unknown>[],
): Promise<void> {
  await artifactStore.writeArtifact(
    relativePath,
    events.length > 0
      ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
      : '',
  );
}
