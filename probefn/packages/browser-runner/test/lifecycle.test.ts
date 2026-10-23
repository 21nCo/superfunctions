import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { BrowserRunner, type LaunchBrowserSessionOptions } from '../src/browser-runner.js';

const deterministic = { enabled: true, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 0 };
let root: string;
let store: ArtifactStore;
let runner: BrowserRunner;
let options: LaunchBrowserSessionOptions;
const browsers: Browser[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'probefn-browser-lifecycle-'));
  store = new ArtifactStore({ repoRoot: root });
  runner = new BrowserRunner({ repoRoot: root, artifactStore: store });
  options = { sessionId: 'owned', runId: 'owned', browser: 'chromium', deterministic, trace: { enabled: false } };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(browsers.splice(0).map(browser => browser.close()));
  await rm(root, { recursive: true, force: true });
});
function observeLaunch(configure: (browser: Browser) => void = () => {}) {
  const launch = chromium.launch.bind(chromium);
  return vi.spyOn(chromium, 'launch').mockImplementation(async config => {
    const browser = await launch(config); browsers.push(browser); configure(browser); return browser;
  });
}

describe.sequential('real Chromium lifecycle ownership', () => {
  it.each(['context', 'tracing', 'navigation'])('closes the launched browser after %s startup failure', async phase => {
    observeLaunch(browser => {
      if (phase === 'context') vi.spyOn(browser, 'newContext').mockRejectedValueOnce(new Error('context failure'));
      if (phase === 'tracing') {
        const newContext = browser.newContext.bind(browser);
        vi.spyOn(browser, 'newContext').mockImplementation(async config => {
          const context = await newContext(config);
          vi.spyOn(context.tracing, 'start').mockRejectedValueOnce(new Error('trace start failure'));
          return context;
        });
      }
    });
    await expect(runner.startSession({ ...options, trace: { enabled: phase === 'tracing' },
      ...(phase === 'navigation' ? { initialUrl: 'http://127.0.0.1:1' } : {}) })).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.isConnected()).toBe(false);
    // Cleanup releases the reservation, so a corrected start can use the same ID.
    vi.restoreAllMocks(); observeLaunch();
    await runner.startSession(options); await runner.stopSession(options.sessionId);
  });

  it('reserves IDs before launch and prevents simultaneous starts from orphaning a browser', async () => {
    const launch = observeLaunch();
    const starting = runner.startSession(options);
    await expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await starting;
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await runner.stopSession(options.sessionId);
    expect(browsers[0]!.isConnected()).toBe(false);
  });

  it('joins an in-progress launch when stopping, without leaking the eventual browser', async () => {
    const launch = chromium.launch.bind(chromium);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(chromium, 'launch').mockImplementation(async config => {
      const browser = await launch(config); browsers.push(browser); await gate; return browser;
    });
    const starting = expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
    const stopping = expect(runner.stopSession(options.sessionId)).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
    await vi.waitFor(() => expect(browsers).toHaveLength(1)); release();
    await Promise.all([starting, stopping]);
    expect(browsers[0]!.isConnected()).toBe(false);
  });

  it('still closes the browser when event persistence fails during stop', async () => {
    observeLaunch();
    const createSink = store.createEventSink.bind(store);
    const rejected = vi.fn(async () => { throw new Error('disk unavailable'); });
    vi.spyOn(store, 'createEventSink').mockImplementation((...args) => {
      const sink = createSink(...args);
      if (args[1] === 'console') vi.spyOn(sink, 'append').mockImplementation(rejected);
      return sink;
    });
    const session = await runner.startSession(options);
    await session.page.evaluate(() => console.log('failure'));
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
    await expect(runner.stopSession(options.sessionId)).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
    expect(browsers[0]!.isConnected()).toBe(false);
    expect((session.page as unknown as { listenerCount(event: string): number }).listenerCount('console')).toBe(0);
    expect(runner.hasSession(options.sessionId)).toBe(true);
    await expect(runner.stopSession(options.sessionId)).resolves.toMatchObject({ tracePath: null });
    expect(runner.hasSession(options.sessionId)).toBe(false);
    await expect(runner.stopSession(options.sessionId)).rejects.toMatchObject({ code: 'E_SESSION_NOT_FOUND' });
  });

  it('still closes the browser when trace persistence fails', async () => {
    observeLaunch();
    const session = await runner.startSession({ ...options, trace: { enabled: true } });
    vi.spyOn(session.page.context().tracing, 'stop').mockRejectedValueOnce(new Error('trace disk unavailable'));
    await expect(runner.stopSession(options.sessionId)).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
    expect(browsers[0]!.isConnected()).toBe(false);
  });

  it('shares concurrent stops and retains ownership for retry if close leaves the browser connected', async () => {
    observeLaunch();
    await runner.startSession(options);
    const browser = browsers[0]!;
    const originalClose = browser.close.bind(browser);
    let reject!: (error: Error) => void;
    const close = vi.spyOn(browser, 'close').mockImplementationOnce(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    const first = runner.stopSession(options.sessionId);
    const second = runner.stopSession(options.sessionId);
    const rejected = Promise.all([expect(first).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' }), expect(second).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' })]);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    reject(new Error('close transport failed')); await rejected;
    expect(browser.isConnected()).toBe(true);
    await expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    close.mockImplementation(originalClose);
    await runner.stopSession(options.sessionId);
    expect(browser.isConnected()).toBe(false);
  });

  it('retains settled sync/async sink failures and drains healthy writes before rejecting flush', async () => {
    observeLaunch();
    const createSink = store.createEventSink.bind(store);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const append = vi.fn().mockImplementationOnce(() => { throw new Error('sync failure'); })
      .mockRejectedValueOnce(new Error('async failure')).mockImplementationOnce(() => gate);
    vi.spyOn(store, 'createEventSink').mockImplementation((...args) => {
      const sink = createSink(...args);
      if (args[1] === 'console') vi.spyOn(sink, 'append').mockImplementation(append);
      return sink;
    });
    const session = await runner.startSession(options);
    await session.page.evaluate(() => { console.log('sync'); console.log('async'); console.log('pending'); });
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(3));
    let settled = false;
    const pending = session.eventCapture.flush().finally(() => { settled = true; });
    const rejection = expect(pending).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'sync failure' }), expect.objectContaining({ message: 'async failure' })] });
    await Promise.resolve(); expect(settled).toBe(false);
    release(); await rejection;
    await session.eventCapture.flush();
    await runner.stopSession(options.sessionId);
    expect(browsers[0]!.isConnected()).toBe(false);
  });
});
