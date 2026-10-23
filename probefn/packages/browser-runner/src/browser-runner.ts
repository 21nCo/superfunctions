import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import type { BrowserEngine, DeterministicSettings } from '@probefn/contracts/config';
import { createProbefnError, isProbefnError } from '@probefn/contracts/errors';
import { ArtifactStore, assertArtifactIdentifier } from '@probefn/storage';

import { attachBrowserEventCapture, type BrowserEventCapture } from './event-capture.js';
import { startTracing, stopTracing } from './trace.js';

export interface LaunchBrowserSessionOptions {
  sessionId: string;
  runId: string;
  browser: BrowserEngine;
  deterministic: DeterministicSettings;
  storageStatePath?: string;
  initialUrl?: string;
  video?: { enabled: boolean };
  trace?: {
    enabled: boolean;
    relativeTracePath?: string;
  };
}

export interface BrowserRunnerOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  now?: () => string;
}

export interface BrowserRuntimeSinkPaths {
  consoleSinkPath: string;
  pageErrorSinkPath: string;
  networkSinkPath: string;
}

export interface StartedBrowserSession {
  sessionId: string;
  runId: string;
  browser: BrowserEngine;
  page: Page;
  eventCapture: BrowserEventCapture;
  sinkPaths: BrowserRuntimeSinkPaths;
  traceEnabled: boolean;
}

export interface ClosedBrowserSession {
  tracePath: string | null;
  sinkPaths: BrowserRuntimeSinkPaths;
}

interface ManagedBrowserSession {
  relativeTracePath?: string;
  finalizedTracePath?: string;
  pendingEventFlush?: boolean;
  videoDirectory?: string;
  browser?: Browser;
  context?: BrowserContext;
  eventCapture?: BrowserEventCapture;
  traceEnabled: boolean;
  runId: string;
  sinkPaths?: BrowserRuntimeSinkPaths;
  cancelled: boolean;
  startDone: Promise<void>;
  stopping?: Promise<ClosedBrowserSession>;
}

export class BrowserRunner {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;
  private readonly now: () => string;
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  public constructor(options: BrowserRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Includes disconnected sessions whose scratch removal or event flush is still pending. */
  public hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  public async startSession(options: LaunchBrowserSessionOptions): Promise<StartedBrowserSession> {
    assertArtifactIdentifier(options.sessionId, 'Session id');
    assertArtifactIdentifier(options.runId, 'Run id');
    const browserType = resolveBrowserType(options.browser);
    if (this.sessions.has(options.sessionId)) {
      throw createProbefnError({ code: 'E_SESSION_ALREADY_RUNNING', message: `Session ${options.sessionId} already has an active browser.`, retryable: false });
    }
    let finishStart!: () => void;
    const session: ManagedBrowserSession = { ...(options.trace?.relativeTracePath ? { relativeTracePath: options.trace.relativeTracePath } : {}), runId: options.runId, traceEnabled: false, cancelled: false,
      startDone: new Promise<void>(resolve => { finishStart = resolve; }) };
    this.sessions.set(options.sessionId, session);
    const checkCancelled = () => { if (session.cancelled) throw new Error('Browser startup was cancelled'); };
    try {
      const browser = await browserType.launch({
        headless: true,
      });
      session.browser = browser;
      checkCancelled();
      if (options.video?.enabled) session.videoDirectory = await mkdtemp(path.join(tmpdir(), 'probefn-video-'));
      checkCancelled();
      const context = await browser.newContext({
        ...(session.videoDirectory ? { recordVideo: { dir: session.videoDirectory } } : {}),
        ...(options.deterministic.enabled ? { viewport: options.deterministic.viewport } : {}),
        ...(options.deterministic.enabled ? { locale: options.deterministic.locale } : {}),
        ...(options.deterministic.enabled ? { timezoneId: options.deterministic.timezone } : {}),
        ...(options.deterministic.enabled ? { colorScheme: options.deterministic.colorScheme } : {}),
        ...(options.deterministic.enabled ? { reducedMotion: options.deterministic.reducedMotion } : {}),
        ...(options.storageStatePath
          ? { storageState: path.resolve(this.repoRoot, options.storageStatePath) }
          : {}),
      });

      session.context = context;
      checkCancelled();
      if (options.deterministic.enabled && options.deterministic.animationPolicy === 'freeze') {
        await context.addInitScript(() => {
          const STYLE_ID = '__probefn_deterministic_style__';
          const ensureStyle = () => {
            const mount = document.head ?? document.documentElement;
            if (!mount) {
              requestAnimationFrame(ensureStyle);
              return;
            }

            if (document.getElementById(STYLE_ID)) {
              return;
            }

            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.innerHTML = `
              *, *::before, *::after {
                animation-duration: 0s !important;
                animation-delay: 0s !important;
                transition-duration: 0s !important;
                scroll-behavior: auto !important;
              }
            `;
            mount.appendChild(style);
          };

          ensureStyle();
        });
      }

      checkCancelled();
      const traceEnabled = options.trace?.enabled ?? true;
      await startTracing(context, {
        repoRoot: this.repoRoot,
        artifactStore: this.artifactStore,
        runId: options.runId,
        enabled: traceEnabled,
      });

      session.traceEnabled = traceEnabled;
      checkCancelled();
      const page = await context.newPage();
      checkCancelled();
      const eventCapture = attachBrowserEventCapture({
        page,
        artifactStore: this.artifactStore,
        runId: options.runId,
        now: this.now,
      });
      session.eventCapture = eventCapture;
      const sinkPaths = {
        consoleSinkPath: eventCapture.sinkPaths.consoleSinkPath,
        pageErrorSinkPath: eventCapture.sinkPaths.pageErrorSinkPath,
        networkSinkPath: eventCapture.sinkPaths.networkSinkPath,
      };

      session.sinkPaths = sinkPaths;
      if (options.initialUrl) {
        await page.goto(options.initialUrl, {
          waitUntil: 'load',
        });
        if (options.deterministic.enabled) {
          await page.waitForTimeout(options.deterministic.networkIdleMs);
        }
      }

      checkCancelled();

      return {
        sessionId: options.sessionId,
        runId: options.runId,
        browser: options.browser,
        page,
        eventCapture,
        sinkPaths,
        traceEnabled,
      };
    } catch (error) {
      const cleanup = await this.cleanupSession(session, false);
      if (!session.browser?.isConnected() && !session.videoDirectory && !session.pendingEventFlush && this.sessions.get(options.sessionId) === session) this.sessions.delete(options.sessionId);
      throw createProbefnError({
        code: 'E_BROWSER_LAUNCH_FAILED',
        message: `Could not launch ${options.browser} browser session.`,
        retryable: true,
        details: {
          browser: options.browser,
          ...((session.videoDirectory || session.pendingEventFlush) ? { cleanupPending: true } : {}),
          ...(session.videoDirectory ? { scratchDirectory: session.videoDirectory } : {}),
        },
        cause: cleanup.errors.length ? new AggregateError([error, ...cleanup.errors], 'Browser startup and cleanup failed') : error,
      });
    } finally { finishStart(); }
  }

  public async flushTrace(sessionId: string, relativeTracePath: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session?.context || !session.traceEnabled || session.cancelled) throw createProbefnError({ code: 'E_SESSION_NOT_FOUND', message: 'Browser trace is not active.', retryable: false });
    await session.eventCapture?.flush();
    return (await stopTracing(session.context, { repoRoot: this.repoRoot, artifactStore: this.artifactStore,
      runId: session.runId, enabled: true, relativeTracePath, chunk: true }))!;
  }

  public async stopSession(sessionId: string, options: { saveTrace?: boolean } = {}): Promise<ClosedBrowserSession> {
    const activeSession = this.sessions.get(sessionId);
    if (!activeSession) {
      throw createProbefnError({
        code: 'E_SESSION_NOT_FOUND',
        message: `Session ${sessionId} was not found.`,
        retryable: false,
        details: {
          sessionId,
        },
      });
    }

    if (activeSession.stopping) return activeSession.stopping;
    activeSession.cancelled = true;
    const stopping = (async () => {
      await activeSession.startDone;
      const result = await this.cleanupSession(activeSession, options.saveTrace ?? true);
      if (!activeSession.browser?.isConnected() && !activeSession.videoDirectory && !activeSession.pendingEventFlush && this.sessions.get(sessionId) === activeSession) this.sessions.delete(sessionId);
      if (result.errors.length === 1 && !activeSession.browser?.isConnected() &&
          isProbefnError(result.errors[0]) && result.errors[0].code === 'E_STORAGE_CAP_EXCEEDED') {
        throw result.errors[0];
      }
      if (result.errors.length || !activeSession.sinkPaths) {
        throw createProbefnError({ code: 'E_BROWSER_LAUNCH_FAILED',
          message: `Could not close browser session ${sessionId} cleanly.`, retryable: true,
          details: { sessionId, ...((activeSession.videoDirectory || activeSession.pendingEventFlush) ? { cleanupPending: true } : {}), ...(activeSession.videoDirectory ? { scratchDirectory: activeSession.videoDirectory } : {}) }, cause: new AggregateError(result.errors, 'Browser cleanup failed or startup was cancelled') });
      }
      return { tracePath: result.tracePath, sinkPaths: activeSession.sinkPaths };
    })();
    activeSession.stopping = stopping;
    try { return await stopping; }
    finally { delete activeSession.stopping; }
  }

  /** Detach collection first; every cleanup stage runs even after a preceding failure. */
  private async cleanupSession(session: ManagedBrowserSession, saveTrace: boolean): Promise<{ tracePath: string | null; errors: unknown[] }> {
    const errors: unknown[] = [];
    let tracePath: string | null = session.finalizedTracePath ?? null;
    try { session.eventCapture?.dispose(); } catch (error) { errors.push(error); }
    try { await session.eventCapture?.flush(); session.pendingEventFlush = false; }
    catch (error) { session.pendingEventFlush = true; errors.push(error); }
    if (saveTrace && session.context && session.traceEnabled) {
      try {
        tracePath = await stopTracing(session.context, { repoRoot: this.repoRoot, artifactStore: this.artifactStore,
          runId: session.runId, enabled: true, ...(session.relativeTracePath ? { relativeTracePath: session.relativeTracePath } : {}) });
        if (tracePath) session.finalizedTracePath = tracePath;
        session.traceEnabled = false;
      } catch (error) { errors.push(error); }
    }
    try { await session.browser?.close(); } catch (error) { errors.push(error); }
    if (!session.browser?.isConnected()) session.traceEnabled = false;
    if (!session.browser?.isConnected() && session.videoDirectory) {
      try { await rm(session.videoDirectory, { recursive: true, force: true }); delete session.videoDirectory; }
      catch (error) { errors.push(error); }
    }
    return { tracePath, errors };
  }

}

function resolveBrowserType(engine: BrowserEngine) {
  switch (engine) {
    case 'chromium':
      return chromium;
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
    default:
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: `Invalid browser engine "${engine}".`,
        retryable: false,
      });
  }
}
