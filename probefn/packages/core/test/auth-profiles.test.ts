import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { BrowserRunner } from '@probefn/browser-runner';
import { createRunManifest, type DeterministicSettings } from '@probefn/contracts';
import { createProbefnError } from '@probefn/contracts/errors';
import {
  AuthProfileStore,
  createCheckpoint,
  SessionManager,
  type PlaywrightStorageState,
} from '../src/index.js';
import { ArtifactStore, filterSensitiveExportData, redactSensitiveData } from '@probefn/storage';

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

const authFixtureUrl = 'http://127.0.0.1:4261/';
const authFixtureOrigin = 'http://127.0.0.1:4261';
const authSessionStorageState: PlaywrightStorageState = {
  cookies: [
    {
      name: 'session',
      value: 'customer-admin-session',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
  ],
  origins: [
    {
      origin: authFixtureOrigin,
      localStorage: [
        { name: 'user', value: 'customer-admin' },
        { name: 'plan', value: 'pro' },
      ],
    },
  ],
};

let authServer: FixtureServer | null = null;

beforeAll(async () => {
  await Promise.all([
    removeRun('run_auth', 'sess_auth'),
    removeRun('run_secret_leak', 'sess_secret_leak'),
    removeRun('run_unstable_export', 'sess_unstable_export'),
    rm(path.resolve(projectRoot, '.artifacts', 'auth-profiles'), {
      recursive: true,
      force: true,
    }),
  ]);

  authServer = await FixtureServer.start(
    `${process.execPath} test/fixtures/vite-auth/server.mjs --port 4261`,
  );

  await seedAuthSession();
  await seedSecretLeakSession();
  await seedUnstableExportSession();
});

afterAll(async () => {
  await authServer?.close();
});

describe.sequential('auth profiles and secure exports', () => {
  it('saves a session storage state as an auth profile and loads it into a new browser session', async () => {
    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
    });
    const authProfileStore = new AuthProfileStore({
      repoRoot: projectRoot,
      artifactStore,
    });
    const saved = await authProfileStore.saveProfileFromPath({
      profileId: 'customer-admin',
      sourceStorageStatePath: authProfileStore.getSessionStorageStatePath('run_auth'),
    });

    expect(saved.storageStatePath).toBe('.artifacts/auth-profiles/customer-admin/storage-state.json');

    const loaded = await authProfileStore.loadProfile('customer-admin');
    expect(loaded.storageState).toEqual(authSessionStorageState);

    const initialized = await authProfileStore.initializeSessionStorageFromProfile({
      profileId: 'customer-admin',
      runId: 'run_auth_loaded',
    });

    const browserRunner = new BrowserRunner({
      repoRoot: projectRoot,
      artifactStore,
    });
    const started = await browserRunner.startSession({
      sessionId: 'sess_auth_loaded',
      runId: 'run_auth_loaded',
      browser: 'chromium',
      deterministic,
      storageStatePath: initialized.storageStatePath,
      initialUrl: authFixtureUrl,
      trace: {
        enabled: false,
      },
    });

    try {
      await started.page.waitForSelector('#status');
      const status = await started.page.locator('#status').textContent();
      expect(status).toBe('customer-admin:pro:customer-admin-session');
    } finally {
      await browserRunner.stopSession('sess_auth_loaded');
      await rm(path.resolve(projectRoot, '.artifacts', 'runs', 'run_auth_loaded'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('returns E_AUTH_PROFILE_NOT_FOUND for missing profiles', async () => {
    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
    });
    const authProfileStore = new AuthProfileStore({
      repoRoot: projectRoot,
      artifactStore,
    });

    await expect(authProfileStore.loadProfile('missing-profile')).rejects.toMatchObject({
      code: 'E_AUTH_PROFILE_NOT_FOUND',
      message: 'Auth profile missing-profile was not found.',
    });
  });

  it('redacts leaked secrets in exported reports, omits auth-profile paths, and preserves instability metadata', async () => {
    const artifactStore = new ArtifactStore({
      repoRoot: projectRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot: projectRoot,
      artifactStore,
    });

    const savedProfile = await new AuthProfileStore({
      repoRoot: projectRoot,
      artifactStore,
    }).saveProfile({
      profileId: 'customer-admin',
      storageState: authSessionStorageState,
    });

    const secretLeakReport = await sessionManager.exportReport({
      sessionId: 'sess_secret_leak',
      format: 'json',
    });
    expect(secretLeakReport.redactedValueCount).toBe(3);
    expect(JSON.stringify(secretLeakReport.reportData)).not.toContain('sk_test_supersecret');
    expect(JSON.stringify(secretLeakReport.reportData)).not.toContain('SESSION=customer-admin-session');
    expect(JSON.stringify(secretLeakReport.reportData)).not.toContain('API_TOKEN=super-secret-value');
    expect(JSON.stringify(secretLeakReport.reportData)).toContain('[REDACTED]');

    const filtered = filterSensitiveExportData({
      artifactReferences: {
        authProfile: savedProfile.storageStatePath,
        report: '.artifacts/runs/run_secret_leak/report.json',
      },
      baselineBundle: [savedProfile.storageStatePath],
    });
    expect(filtered.omittedAuthProfilePaths).toBe(2);
    expect(filtered.value).toEqual({
      artifactReferences: {
        report: '.artifacts/runs/run_secret_leak/report.json',
      },
      baselineBundle: [],
    });

    const unstableReport = await sessionManager.exportReport({
      sessionId: 'sess_unstable_export',
      format: 'json',
    });
    expect(unstableReport.reportData.checkpointIndex).toEqual([
      expect.objectContaining({
        checkpointId: 'chk_mobile',
        unstable: true,
      }),
    ]);
    expect(unstableReport.reportData.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: 'df_overflow',
          unstable: true,
        }),
      ]),
    );
    expect(unstableReport.warnings).toEqual(
      expect.arrayContaining([
        'Checkpoint chk_mobile was captured during dev-server instability.',
      ]),
    );
  });

  it('returns E_REDACTION_FAILURE when the redaction pipeline encounters an unsafe circular object', () => {
    const circular: { self?: unknown; authorization: string } = {
      authorization: 'Bearer sk_test_supersecret',
    };
    circular.self = circular;

    expect(() => redactSensitiveData(circular)).toThrowError(
      createProbefnError({
        code: 'E_REDACTION_FAILURE',
        message: 'Redaction pipeline failed before sensitive data could be persisted safely.',
        retryable: false,
        details: {
          path: 'self',
        },
      }),
    );
  });
});

async function seedAuthSession(): Promise<void> {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });
  const sessionManager = new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const authProfileStore = new AuthProfileStore({
    repoRoot: projectRoot,
    artifactStore,
  });
  const runId = 'run_auth';
  const sessionId = 'sess_auth';
  const runPaths = artifactStore.getRunPaths(runId);
  const storageStatePath = await authProfileStore.writeSessionStorageState({
    runId,
    storageState: authSessionStorageState,
  });

  await artifactStore.writeRunManifest(
    runId,
    createRunManifest({
      sessionId,
      runId,
      mode: 'debug',
      browser: 'chromium',
      artifactRoot: runPaths.runRoot,
      startedAt: '2026-04-16T05:00:00Z',
      endedAt: '2026-04-16T05:00:00Z',
      status: 'completed',
      deterministic,
      devServer: {
        mode: 'attach',
        name: 'auth-fixture',
        url: authFixtureUrl,
        resolvedUrl: authFixtureUrl,
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
    startedAt: '2026-04-16T05:00:00Z',
    manifestPath: runPaths.sessionManifestPath,
    resolvedUrl: authFixtureUrl,
    artifacts: {
      storageStatePath,
    },
  });
  await sessionManager.markCompleted(sessionId, {
    endedAt: '2026-04-16T05:00:00Z',
    artifacts: {
      storageStatePath,
    },
  });
}

async function seedSecretLeakSession(): Promise<void> {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });
  const sessionManager = new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const runId = 'run_secret_leak';
  const sessionId = 'sess_secret_leak';
  const runPaths = artifactStore.getRunPaths(runId);

  await artifactStore.writeRunManifest(
    runId,
    createRunManifest({
      sessionId,
      runId,
      mode: 'debug',
      browser: 'chromium',
      artifactRoot: runPaths.runRoot,
      startedAt: '2026-04-16T05:02:00Z',
      endedAt: '2026-04-16T05:02:00Z',
      status: 'completed',
      deterministic,
      devServer: {
        mode: 'attach',
        name: 'secret-leak',
        url: 'http://127.0.0.1:4999/',
        resolvedUrl: 'http://127.0.0.1:4999/',
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
    startedAt: '2026-04-16T05:02:00Z',
    manifestPath: runPaths.sessionManifestPath,
    resolvedUrl: 'http://127.0.0.1:4999/',
    artifacts: {
      consoleSinkPath: path.posix.join(runPaths.eventRoot, 'console.ndjson'),
      pageErrorSinkPath: path.posix.join(runPaths.eventRoot, 'page-errors.ndjson'),
      networkSinkPath: path.posix.join(runPaths.eventRoot, 'network.ndjson'),
      devServerStdoutSinkPath: path.posix.join(runPaths.devServerRoot, 'stdout.ndjson'),
      devServerStderrSinkPath: path.posix.join(runPaths.devServerRoot, 'stderr.ndjson'),
    },
  });

  const consoleSink = artifactStore.createEventSink(runId, 'console', 'events');
  const pageErrorSink = artifactStore.createEventSink(runId, 'page-errors', 'events');
  const networkSink = artifactStore.createEventSink(runId, 'network', 'events');
  const stdoutSink = artifactStore.createEventSink(runId, 'stdout', 'devserver');
  const stderrSink = artifactStore.createEventSink(runId, 'stderr', 'devserver');

  await consoleSink.append({
    ts: '2026-04-16T05:02:01Z',
    source: 'browser',
    type: 'console',
    level: 'error',
    text: 'Bearer sk_test_supersecret',
    pageUrl: 'http://127.0.0.1:4999/',
  });
  await pageErrorSink.append({
    ts: '2026-04-16T05:02:02Z',
    source: 'browser',
    type: 'page-error',
    message: 'SESSION=customer-admin-session',
    pageUrl: 'http://127.0.0.1:4999/',
  });
  await networkSink.append({
    ts: '2026-04-16T05:02:03Z',
    source: 'browser',
    type: 'response-failure',
    url: 'http://127.0.0.1:4999/api/orders',
    method: 'GET',
    status: 500,
    statusText: 'Internal Server Error',
    resourceType: 'fetch',
    pageUrl: 'http://127.0.0.1:4999/',
  });
  await stdoutSink.append({
    ts: '2026-04-16T05:02:04Z',
    source: 'dev-server',
    stream: 'stdout',
    line: 'API_TOKEN=super-secret-value',
  });
  await stderrSink.append({
    ts: '2026-04-16T05:02:05Z',
    source: 'dev-server',
    stream: 'stderr',
    line: 'warning: simulated stderr',
  });

  await sessionManager.markCompleted(sessionId, {
    endedAt: '2026-04-16T05:02:00Z',
  });
}

async function seedUnstableExportSession(): Promise<void> {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });
  const sessionManager = new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const runId = 'run_unstable_export';
  const sessionId = 'sess_unstable_export';
  const runPaths = artifactStore.getRunPaths(runId);

  await artifactStore.writeRunManifest(
    runId,
    createRunManifest({
      sessionId,
      runId,
      mode: 'design-review',
      browser: 'chromium',
      artifactRoot: runPaths.runRoot,
      startedAt: '2026-04-16T05:03:00Z',
      endedAt: '2026-04-16T05:03:00Z',
      status: 'completed',
      deterministic: {
        ...deterministic,
        viewport: {
          width: 390,
          height: 844,
        },
      },
      unstable: true,
      devServer: {
        mode: 'attach',
        name: 'unstable',
        url: 'http://127.0.0.1:5001/',
        resolvedUrl: 'http://127.0.0.1:5001/',
      },
    }),
  );

  await sessionManager.initialize({
    sessionId,
    runId,
    mode: 'design-review',
    browser: 'chromium',
    deterministic: {
      ...deterministic,
      viewport: {
        width: 390,
        height: 844,
      },
    },
    artifactRoot: runPaths.runRoot,
    startedAt: '2026-04-16T05:03:00Z',
    manifestPath: runPaths.sessionManifestPath,
    resolvedUrl: 'http://127.0.0.1:5001/',
  });

  await createCheckpoint({
    repoRoot: projectRoot,
    artifactStore,
    sessionId,
    runId,
    browser: 'chromium',
    name: 'mobile',
    unstable: true,
    delta: {
      newConsoleErrors: 0,
      newPageErrors: 0,
      newNetworkFailures: 0,
    },
    includeStyles: true,
    source: {
      url: () => 'http://127.0.0.1:5001/',
      viewportSize: () => ({ width: 390, height: 844 }),
      screenshot: async () => Buffer.from('png:run_unstable_export'),
      domSnapshot: async () => ({ html: '<main>unstable export</main>' }),
      accessibilitySnapshot: async () => ({ snapshot: '- main "unstable export"' }),
      layoutSnapshot: async () => ({
        url: 'http://127.0.0.1:5001/',
        elements: [
          {
            elementId: 'el_pricing_grid',
            role: 'region',
            name: 'Pricing Grid',
            text: 'Pricing Grid',
            visible: true,
            disabled: false,
            bounds: {
              x: 0,
              y: 96,
              width: 414,
              height: 240,
            },
            selectorHints: {
              id: 'pricing-grid',
              role: 'region',
              name: 'Pricing Grid',
            },
          },
        ],
      }),
      stylesSnapshot: async () => ({
        elements: [],
      }),
    },
    now: () => '2026-04-16T05:03:00Z',
  });

  await sessionManager.markCompleted(sessionId, {
    endedAt: '2026-04-16T05:03:00Z',
  });
}

async function removeRun(runId: string, sessionId: string): Promise<void> {
  await Promise.all([
    rm(path.resolve(projectRoot, '.artifacts', 'runs', runId), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(projectRoot, '.artifacts', 'session-state', `${sessionId}.json`), {
      force: true,
    }),
  ]);
}

class FixtureServer {
  private readonly child: ChildProcess;

  private constructor(child: ChildProcess) {
    this.child = child;
  }

  public static async start(command: string): Promise<FixtureServer> {
    const child = spawn(command, {
      cwd: projectRoot,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Fixture server did not become ready in time.'));
      }, 5000);
      const handleData = (chunk: Buffer | string) => {
        if (chunk.toString().includes('Local: http://127.0.0.1:4261')) {
          clearTimeout(timer);
          child.stdout.off('data', handleData);
          resolve();
        }
      };
      child.stdout.on('data', handleData);
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Fixture server exited early with code ${code ?? 'unknown'}.`));
      });
    });

    return new FixtureServer(child);
  }

  public async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
    });
  }
}
