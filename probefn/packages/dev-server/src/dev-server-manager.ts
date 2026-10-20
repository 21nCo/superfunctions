import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import type {
  BrowserEngine,
  DeterministicSettings,
  DevServerSpec,
  SessionMode,
} from '@probefn/contracts/config';
import { createProbefnError } from '@probefn/contracts/errors';
import { createRunManifest, type RunManifest } from '@probefn/contracts/manifests';
import { ArtifactStore, assertArtifactIdentifier } from '@probefn/storage';

import {
  createLineProcessor,
  detectInstability,
  toDevServerSinkEvent,
  type DevServerSinkEvent,
} from './process-events.js';
import { compileReadyPattern, detectReadiness } from './readiness.js';

export interface StartSessionOptions {
  sessionId: string;
  runId: string;
  mode: SessionMode;
  browser: BrowserEngine;
  deterministic: DeterministicSettings;
  devServer: DevServerSpec;
}

export interface StartedSession {
  sessionId: string;
  runId: string;
  artifactRoot: string;
  startedAt: string;
  resolvedUrl: string;
  manifestPath: string;
  stdoutSinkPath?: string;
  stderrSinkPath?: string;
}

export interface ManagedSessionState {
  sessionId: string;
  runId: string;
  child?: ChildProcess;
  exitMonitor?: Promise<void>;
  closed?: Promise<void>;
  outputFailure?: unknown;
  cleanupFailure?: unknown;
  startupAbort: AbortController;
  startupDone: Promise<void>;
  manifest: RunManifest;
  manifestPath: string;
  stdoutSinkPath?: string;
  stderrSinkPath?: string;
  ready: boolean;
  stopping?: boolean;
}

export interface DevServerManagerOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  now?: () => string;
  /** Grace period before killing a spawned process group. Default 1000 ms. */
  shutdownTimeoutMs?: number;
}

export class DevServerManager {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;
  private readonly now: () => string;
  private readonly shutdownTimeoutMs: number;
  private readonly sessions = new Map<string, ManagedSessionState>();

  public constructor(options: DevServerManagerOptions) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1000;
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1) throw new TypeError('Invalid shutdownTimeoutMs');
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async startSession(options: StartSessionOptions): Promise<StartedSession> {
    assertArtifactIdentifier(options.sessionId, 'Session id');
    assertArtifactIdentifier(options.runId, 'Run id');
    const existingSession = this.sessions.get(options.sessionId);
    if (existingSession) {
      throw createProbefnError({
        code: 'E_SESSION_ALREADY_RUNNING',
        message: `Session ${options.sessionId} already has an active run.`,
        retryable: false,
        details: {
          sessionId: options.sessionId,
          runId: existingSession.runId,
        },
      });
    }

    const startedAt = this.now();
    const manifestPath = this.artifactStore.getRunPaths(options.runId).sessionManifestPath;
    const manifest = createRunManifest({
      sessionId: options.sessionId,
      runId: options.runId,
      mode: options.mode,
      browser: options.browser,
      artifactRoot: this.artifactStore.getRunPaths(options.runId).runRoot,
      startedAt,
      status: 'running',
      deterministic: options.deterministic,
      unstable: false,
      devServer: {
        mode: options.devServer.mode,
        name: options.devServer.name,
        url: options.devServer.url ?? '',
        ...(options.devServer.readyPattern ? { readyPattern: options.devServer.readyPattern } : {}),
      },
    });

    let finishStartup!: () => void;
    const startupDone = new Promise<void>(resolve => { finishStartup = resolve; });
    const session: ManagedSessionState = {
      startupAbort: new AbortController(),
      startupDone,
      sessionId: options.sessionId,
      runId: options.runId,
      manifest,
      manifestPath,
      ready: false,
    };

    this.sessions.set(options.sessionId, session);

    try {
      await this.persistManifest(session);
      session.startupAbort.signal.throwIfAborted();
      const resolvedUrl =
        options.devServer.mode === 'attach'
          ? await this.startAttachedSession(session, options.devServer)
          : await this.startSpawnedSession(session, options.devServer);

      session.startupAbort.signal.throwIfAborted();
      await this.persistManifest(session);
      session.startupAbort.signal.throwIfAborted();
      session.ready = true;

      return {
        sessionId: session.sessionId,
        runId: session.runId,
        artifactRoot: session.manifest.artifactRoot,
        startedAt: session.manifest.startedAt,
        resolvedUrl,
        manifestPath: session.manifestPath,
        ...(session.stdoutSinkPath ? { stdoutSinkPath: session.stdoutSinkPath } : {}),
        ...(session.stderrSinkPath ? { stderrSinkPath: session.stderrSinkPath } : {}),
      };
    } catch (error) {
      try {
        await this.failSession(session);
      } catch (cleanupError) {
        session.cleanupFailure = cleanupError;
        throw new AggregateError([error, cleanupError], 'Session startup and cleanup failed');
      }
      throw error;
    } finally {
      finishStartup();
    }
  }

  public async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw createProbefnError({
        code: 'E_SESSION_NOT_FOUND',
        message: `Session ${sessionId} was not found.`,
        retryable: false,
        details: {
          sessionId,
        },
      });
    }

    session.stopping = true;
    session.startupAbort.abort(createProbefnError({
      code: 'E_SESSION_START_CANCELLED',
      message: 'Session startup was cancelled by stopSession.',
      retryable: false,
    }));
    await session.startupDone;
    if (this.sessions.get(sessionId) !== session) {
      if (session.cleanupFailure) throw session.cleanupFailure;
      return;
    }
    if (session.child) await terminateChildProcessGroup(session.child, session.closed!, this.shutdownTimeoutMs);
    await session.exitMonitor;
    if (session.outputFailure) session.manifest.status = 'failed';

    session.manifest.status = session.manifest.status === 'failed' ? 'failed' : 'completed';
    session.manifest.endedAt = this.now();
    await this.persistManifest(session);
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    if (session.outputFailure) throw session.outputFailure;
  }

  private async startAttachedSession(
    session: ManagedSessionState,
    devServer: DevServerSpec,
  ): Promise<string> {
    const resolvedUrl = devServer.url ?? '';
    const timeoutMs = devServer.timeoutMs ?? 120000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      session.startupAbort.signal.throwIfAborted();
      try {
        const controller = new AbortController();
        const cancelFetch = () => controller.abort(session.startupAbort.signal.reason);
        session.startupAbort.signal.addEventListener('abort', cancelFetch, { once: true });
        const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(1000, deadline - Date.now())));
        let response: Response;
        try { response = await fetch(resolvedUrl, { signal: controller.signal }); }
        finally {
          clearTimeout(timer);
          session.startupAbort.signal.removeEventListener('abort', cancelFetch);
        }
        await response.body?.cancel();

        if (response.ok) {
          const currentDevServer = session.manifest.devServer;
          session.manifest.devServer = {
            mode: currentDevServer?.mode ?? devServer.mode,
            name: currentDevServer?.name ?? devServer.name,
            url: resolvedUrl,
            resolvedUrl,
            ...(currentDevServer?.readyPattern ? { readyPattern: currentDevServer.readyPattern } : {}),
          };
          return resolvedUrl;
        }

        lastError = new Error(`Unexpected response status ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      session.startupAbort.signal.throwIfAborted();
      await delay(Math.max(0, Math.min(100, deadline - Date.now())));
    }

    throw createProbefnError({
      code: 'E_URL_UNREACHABLE',
      message: `Could not reach ${resolvedUrl} before session start.`,
      retryable: true,
      details: {
        url: resolvedUrl,
      },
      cause: lastError,
    });
  }

  private async startSpawnedSession(
    session: ManagedSessionState,
    devServer: DevServerSpec,
  ): Promise<string> {
    if (!devServer.command || !devServer.url) {
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: 'Spawn dev servers require both command and url.',
        retryable: false,
      });
    }

    const readyPatterns = compileReadyPattern(devServer.readyPattern ?? 'Local:\\s+(https?:\\/\\/[^\\s]+)');
    const timeoutMs = devServer.timeoutMs ?? 120000;

    const configuredUrl = devServer.url;

    const stdoutSink = this.artifactStore.createEventSink(session.runId, 'stdout', 'devserver');
    const stderrSink = this.artifactStore.createEventSink(session.runId, 'stderr', 'devserver');
    session.stdoutSinkPath = stdoutSink.getCurrentRelativePath();
    session.stderrSinkPath = stderrSink.getCurrentRelativePath();

    const child = spawn(devServer.command, {
      cwd: path.resolve(this.repoRoot, devServer.cwd ?? '.'),
      shell: true,
      detached: true,
      env: createAllowedEnvironment(devServer.envAllowlist),
    });
    session.child = child;
    session.closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    if (typeof child.pid === 'number') {
      session.manifest.devServer = {
        ...(session.manifest.devServer ?? {
          mode: devServer.mode,
          name: devServer.name,
          url: configuredUrl,
        }),
        pid: child.pid,
      };
    }

    let resolvedUrl = configuredUrl;
    let settled = false;
    let resolveReady!: (url: string) => void;
    let rejectReady!: (error: unknown) => void;
    const readinessPromise = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const cancelReadiness = () => rejectReady(session.startupAbort.signal.reason);
    session.startupAbort.signal.addEventListener('abort', cancelReadiness, { once: true });
    const recordOutputFailure = (error: unknown) => { session.outputFailure ??= error; rejectReady(error); };


    const onLine = async (line: string, stream: 'stdout' | 'stderr'): Promise<void> => {
      const event: DevServerSinkEvent = toDevServerSinkEvent(this.now(), stream, line);
      const appendResult =
        stream === 'stdout'
          ? await stdoutSink.append(event)
          : await stderrSink.append(event);

      if (stream === 'stdout') {
        session.stdoutSinkPath = appendResult.relativePath;
      } else {
        session.stderrSinkPath = appendResult.relativePath;
      }

      const readiness = detectReadiness(line, readyPatterns);
      if (!settled && readiness.ready) {
        settled = true;
        if (readiness.resolvedUrl) {
          resolvedUrl = readiness.resolvedUrl;
        }
        const currentDevServer = session.manifest.devServer;
        session.manifest.devServer = {
          mode: currentDevServer?.mode ?? devServer.mode,
          name: currentDevServer?.name ?? devServer.name,
          url: configuredUrl,
          resolvedUrl,
          ...(currentDevServer?.pid ? { pid: currentDevServer.pid } : {}),
          ...(currentDevServer?.readyPattern || devServer.readyPattern
            ? { readyPattern: currentDevServer?.readyPattern ?? devServer.readyPattern! }
            : {}),
        };
      }

      if (settled) resolveReady(resolvedUrl);

      const instability = detectInstability(line);
      if (instability.unstable) {
        session.manifest.unstable = true;
        await this.persistManifest(session);
      }
    };

    const stdoutProcessor = createLineProcessor('stdout', onLine);
    const stderrProcessor = createLineProcessor('stderr', onLine);

    child.stdout?.on('data', (chunk) => {
      void stdoutProcessor.push(chunk).catch(recordOutputFailure);
    });
    child.stderr?.on('data', (chunk) => {
      void stderrProcessor.push(chunk).catch(recordOutputFailure);
    });

    const exitPromise = once(child, 'close').then(async ([code, signal]) => {
      const drains = await Promise.allSettled([stdoutProcessor.flush(), stderrProcessor.flush()]);
      const failedDrain = drains.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failedDrain) throw failedDrain.reason;

      if (!settled) {
        throw createProbefnError({
          code: 'E_DEVSERVER_EXIT_EARLY',
          message: `Dev server exited before readiness with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`,
          retryable: true,
          details: {
            code: code ?? null,
            signal: signal ?? null,
          },
        });
      }

      if (!session.stopping) {
        session.manifest.unstable = true;
        await this.persistManifest(session);
      }
      return resolvedUrl;
    });
    session.exitMonitor = exitPromise.then(() => undefined).catch(error => { if (settled) session.outputFailure ??= error; });

    let readinessTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const readyUrl = await Promise.race([
        readinessPromise,
        exitPromise,
        new Promise<never>((_resolve, reject) => {
          readinessTimer = setTimeout(() => reject(createProbefnError({
            code: 'E_DEVSERVER_START_TIMEOUT',
            message: `Dev server did not become ready within ${timeoutMs}ms.`,
            retryable: true,
            details: {
              timeoutMs,
            },
          })), timeoutMs);
        }),
      ]);

      return readyUrl;
    } finally {
      clearTimeout(readinessTimer);
      session.startupAbort.signal.removeEventListener('abort', cancelReadiness);
    }
  }

  private async failSession(session: ManagedSessionState): Promise<void> {
    session.stopping = true;
    let processCleanupComplete = false;
    try {
      if (session.child) await terminateChildProcessGroup(session.child, session.closed!, this.shutdownTimeoutMs);
      await session.exitMonitor;
      processCleanupComplete = true;
    } finally {
      session.manifest.status = 'failed';
      session.manifest.endedAt = this.now();
      try {
        await this.persistManifest(session);
      } finally {
        if (processCleanupComplete && this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
      }
    }
  }

  private async persistManifest(session: ManagedSessionState): Promise<void> {
    await this.artifactStore.writeRunManifest(session.runId, session.manifest);
  }
}

function createAllowedEnvironment(envAllowlist: string[]): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const key of envAllowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      nextEnv[key] = value;
    }
  }

  return {
    ...nextEnv,
    PATH: process.env.PATH,
  };
}

async function terminateChildProcessGroup(child: ChildProcess, closed: Promise<void>, timeoutMs: number): Promise<void> {
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let processClosed = false;
  void closed.then(() => { processClosed = true; });
  const groupExists = (): boolean => {
    if (process.platform === 'win32' || typeof child.pid !== 'number') return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const waitForClose = async (): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (processClosed && !groupExists()) return true;
      await delay(Math.max(1, Math.min(10, deadline - Date.now())));
    } while (Date.now() < deadline);
    return processClosed && !groupExists();
  };
  signal('SIGTERM');
  if (await waitForClose()) return;
  signal('SIGKILL');
  if (!await waitForClose()) throw new Error('Dev server process did not close after SIGKILL');
}
