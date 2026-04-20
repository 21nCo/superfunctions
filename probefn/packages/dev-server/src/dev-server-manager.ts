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
import { ArtifactStore } from '@probefn/storage';

import {
  createLineProcessor,
  detectInstability,
  toDevServerSinkEvent,
  type DevServerSinkEvent,
  type LineProcessor,
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
}

export class DevServerManager {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;
  private readonly now: () => string;
  private readonly sessions = new Map<string, ManagedSessionState>();

  public constructor(options: DevServerManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async startSession(options: StartSessionOptions): Promise<StartedSession> {
    const existingSession = this.sessions.get(options.sessionId);
    if (existingSession && existingSession.manifest.status === 'running') {
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

    await this.artifactStore.writeRunManifest(options.runId, manifest);

    const session: ManagedSessionState = {
      sessionId: options.sessionId,
      runId: options.runId,
      manifest,
      manifestPath,
      ready: false,
    };

    this.sessions.set(options.sessionId, session);

    try {
      const resolvedUrl =
        options.devServer.mode === 'attach'
          ? await this.startAttachedSession(session, options.devServer)
          : await this.startSpawnedSession(session, options.devServer);

      session.ready = true;
      await this.persistManifest(session);

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
      await this.failSession(session, error);
      throw error;
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

    if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
      session.stopping = true;
      session.child.kill('SIGTERM');
      await once(session.child, 'exit');
      await session.exitMonitor;
    } else {
      await session.exitMonitor;
    }

    session.manifest.status = session.manifest.status === 'failed' ? 'failed' : 'completed';
    session.manifest.endedAt = this.now();
    await this.persistManifest(session);
    this.sessions.delete(sessionId);
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
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1000);
        const response = await fetch(resolvedUrl, {
          signal: controller.signal,
        });
        clearTimeout(timer);

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

      await delay(100);
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

    const configuredUrl = devServer.url;

    const stdoutSink = this.artifactStore.createEventSink(session.runId, 'stdout', 'devserver');
    const stderrSink = this.artifactStore.createEventSink(session.runId, 'stderr', 'devserver');
    session.stdoutSinkPath = stdoutSink.getCurrentRelativePath();
    session.stderrSinkPath = stderrSink.getCurrentRelativePath();

    const child = spawn(devServer.command, {
      cwd: path.resolve(this.repoRoot, devServer.cwd ?? '.'),
      shell: true,
      detached: true,
      env: process.env,
    });
    session.child = child;
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

    const readyPatterns = compileReadyPattern(devServer.readyPattern ?? 'Local:\\s+(https?:\\/\\/[^\\s]+)');
    const timeoutMs = devServer.timeoutMs ?? 120000;
    let resolvedUrl = configuredUrl;
    let settled = false;

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

      const instability = detectInstability(line);
      if (instability.unstable) {
        session.manifest.unstable = true;
        await this.persistManifest(session);
      }
    };

    const stdoutProcessor = createLineProcessor('stdout', onLine);
    const stderrProcessor = createLineProcessor('stderr', onLine);

    child.stdout?.on('data', (chunk) => {
      void stdoutProcessor.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      void stderrProcessor.push(chunk);
    });

    const exitPromise = once(child, 'exit').then(async ([code, signal]) => {
      await stdoutProcessor.flush();
      await stderrProcessor.flush();

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
    session.exitMonitor = exitPromise.then(() => undefined).catch(() => undefined);

    const readinessPromise = new Promise<string>((resolve) => {
      const interval = setInterval(() => {
        if (settled) {
          clearInterval(interval);
          resolve(resolvedUrl);
        }
      }, 25);
    });

    try {
      const readyUrl = await Promise.race([
        readinessPromise,
        exitPromise,
        delay(timeoutMs).then(() => {
          throw createProbefnError({
            code: 'E_DEVSERVER_START_TIMEOUT',
            message: `Dev server did not become ready within ${timeoutMs}ms.`,
            retryable: true,
            details: {
              timeoutMs,
            },
          });
        }),
      ]);

      return readyUrl;
    } catch (error) {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      await stdoutProcessor.flush();
      await stderrProcessor.flush();
      throw error;
    }
  }

  private async failSession(session: ManagedSessionState, error: unknown): Promise<void> {
    session.manifest.status = 'failed';
    session.manifest.endedAt = this.now();
    await this.persistManifest(session);

    if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill('SIGTERM');
      await once(session.child, 'exit').catch(() => undefined);
      await session.exitMonitor;
    }

    this.sessions.delete(session.sessionId);
  }

  private async persistManifest(session: ManagedSessionState): Promise<void> {
    await this.artifactStore.writeRunManifest(session.runId, session.manifest);
  }
}
