import path from 'node:path';

import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

import type { BrowserEngine, DeterministicSettings } from '@probefn/contracts/config';
import { createProbefnError } from '@probefn/contracts/errors';
import { ArtifactStore } from '@probefn/storage';

import { attachBrowserEventCapture, type BrowserEventCapture } from './event-capture.js';
import { startTracing, stopTracing } from './trace.js';

export interface LaunchBrowserSessionOptions {
  sessionId: string;
  runId: string;
  browser: BrowserEngine;
  deterministic: DeterministicSettings;
  storageStatePath?: string;
  initialUrl?: string;
  trace?: {
    enabled: boolean;
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

export class BrowserRunner {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;
  private readonly now: () => string;
  private readonly sessions = new Map<
    string,
    {
      browser: Browser;
      context: BrowserContext;
      page: Page;
      eventCapture: BrowserEventCapture;
      traceEnabled: boolean;
      runId: string;
      sinkPaths: BrowserRuntimeSinkPaths;
    }
  >();

  public constructor(options: BrowserRunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async startSession(options: LaunchBrowserSessionOptions): Promise<StartedBrowserSession> {
    const browserType = resolveBrowserType(options.browser);

    try {
      const browser = await browserType.launch({
        headless: true,
      });
      const context = await browser.newContext({
        ...(options.deterministic.enabled ? { viewport: options.deterministic.viewport } : {}),
        ...(options.deterministic.enabled ? { locale: options.deterministic.locale } : {}),
        ...(options.deterministic.enabled ? { timezoneId: options.deterministic.timezone } : {}),
        ...(options.deterministic.enabled ? { colorScheme: options.deterministic.colorScheme } : {}),
        ...(options.deterministic.enabled ? { reducedMotion: options.deterministic.reducedMotion } : {}),
        ...(options.storageStatePath
          ? { storageState: path.resolve(this.repoRoot, options.storageStatePath) }
          : {}),
      });

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

      const traceEnabled = options.trace?.enabled ?? true;
      await startTracing(context, {
        repoRoot: this.repoRoot,
        artifactStore: this.artifactStore,
        runId: options.runId,
        enabled: traceEnabled,
      });

      const page = await context.newPage();
      const eventCapture = attachBrowserEventCapture({
        page,
        artifactStore: this.artifactStore,
        runId: options.runId,
        now: this.now,
      });
      const sinkPaths = {
        consoleSinkPath: eventCapture.sinkPaths.consoleSinkPath,
        pageErrorSinkPath: eventCapture.sinkPaths.pageErrorSinkPath,
        networkSinkPath: eventCapture.sinkPaths.networkSinkPath,
      };

      if (options.initialUrl) {
        await page.goto(options.initialUrl, {
          waitUntil: 'load',
        });
        if (options.deterministic.enabled) {
          await page.waitForTimeout(options.deterministic.networkIdleMs);
        }
      }

      this.sessions.set(options.sessionId, {
        browser,
        context,
        page,
        eventCapture,
        traceEnabled,
        runId: options.runId,
        sinkPaths,
      });

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
      throw createProbefnError({
        code: 'E_BROWSER_LAUNCH_FAILED',
        message: `Could not launch ${options.browser} browser session.`,
        retryable: true,
        details: {
          browser: options.browser,
        },
        cause: error,
      });
    }
  }

  public async stopSession(sessionId: string): Promise<ClosedBrowserSession> {
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

    try {
      await activeSession.eventCapture.flush();
      activeSession.eventCapture.dispose();
      const tracePath = await stopTracing(activeSession.context, {
        repoRoot: this.repoRoot,
        artifactStore: this.artifactStore,
        runId: activeSession.runId,
        enabled: activeSession.traceEnabled,
      });
      await activeSession.browser.close();
      return {
        tracePath,
        sinkPaths: activeSession.sinkPaths,
      };
    } catch (error) {
      throw createProbefnError({
        code: 'E_BROWSER_LAUNCH_FAILED',
        message: `Could not close browser session ${sessionId} cleanly.`,
        retryable: true,
        details: {
          sessionId,
        },
        cause: error,
      });
    } finally {
      this.sessions.delete(sessionId);
    }
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
