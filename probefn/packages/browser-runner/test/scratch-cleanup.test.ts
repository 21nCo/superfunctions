import { createServer } from 'node:http';
import { ProbefnRuntime, startSessionFromConfig, createCheckpointFromSession, stopSession, openPage } from '@probefn/mcp-server';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { createProbefnError, toErrorEnvelope } from '@probefn/contracts/errors';
import { BrowserRunner } from '../src/browser-runner.js';
const fault = vi.hoisted(() => ({ enabled: false, trace: false, paths: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
    if (fault.enabled && path.basename(String(args[0])).startsWith(fault.trace ? 'probefn-trace-' : 'probefn-video-')) { fault.paths.push(String(args[0])); throw new Error('owned scratch removal failed'); }
    return fs.rm(...args);
  } };
});
const roots: string[] = [], browsers: Browser[] = [];
afterEach(async () => {
  fault.enabled = false; fault.trace = false; vi.restoreAllMocks();
  await Promise.all(browsers.splice(0).map(browser => browser.close()));
  for (const target of [...roots.splice(0), ...fault.paths.splice(0)]) await rm(target, { recursive: true, force: true });
});
it.each([false, true])('retains disconnected browser scratch ownership until cleanup succeeds (startup failure=%s)', async startupFailure => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-scratch-owner-')); roots.push(root);
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: new ArtifactStore({ repoRoot: root }) });
  const launch = chromium.launch.bind(chromium);
  vi.spyOn(chromium, 'launch').mockImplementation(async options => {
    const browser = await launch(options); browsers.push(browser);
    if (startupFailure && browsers.length === 1) vi.spyOn(browser, 'newContext').mockRejectedValueOnce(new Error('injected context failure'));
    return browser;
  });
  const options = { sessionId: 'owned', runId: 'owned', browser: 'chromium' as const, deterministic: { enabled: false, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 0 }, trace: { enabled: false }, video: { enabled: true } };
  if (startupFailure) {
    fault.enabled = true;
    await expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
  } else {
    await runner.startSession(options); fault.enabled = true;
    await expect(runner.stopSession('owned')).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
  }
  expect(browsers[0]!.isConnected()).toBe(false);
  expect(fault.paths).toHaveLength(1);
  expect((await stat(fault.paths[0]!)).isDirectory()).toBe(true);
  await expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
  fault.enabled = false;
  if (startupFailure) await expect(runner.stopSession('owned')).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
  else await runner.stopSession('owned');
  await expect(stat(fault.paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  await runner.startSession(options); await runner.stopSession('owned');
});

it('keeps the public runtime owner after video cleanup failure and allows an explicit stop retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-scratch-runtime-')); roots.push(root);
  const app = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<body>Video ownership</body>'); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const runtime = new ProbefnRuntime(root);
  const other = new ProbefnRuntime(root);
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ projectName: 'cleanup', devServers: { web: { mode: 'attach', name: 'web', url: `http://127.0.0.1:${address.port}` } }, deterministicDefaults: { networkIdleMs: 10 } })}`);
  try {
    await startSessionFromConfig(runtime, { configPath: 'config.mjs', sessionId: 'cleanup', runId: 'cleanup' });
    fault.enabled = true;
    await expect(createCheckpointFromSession(runtime, { sessionId: 'cleanup', name: 'video', includeVideo: true })).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED' });
    expect(fault.paths.length).toBeGreaterThan(0);
    const directory = fault.paths[0]!;
    expect((await stat(directory)).isDirectory()).toBe(true);
    await expect(createCheckpointFromSession(runtime, { sessionId: 'cleanup', name: 'blocked' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await expect(stopSession(other, 'cleanup')).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    fault.enabled = false;
    const resolveContext = vi.spyOn(runtime, 'resolveSessionContext').mockRejectedValueOnce(new Error('Injected trace receipt persistence failure'));
    await expect(stopSession(runtime, 'cleanup')).rejects.toThrow('Injected trace receipt persistence failure');
    resolveContext.mockRestore();
    await expect(stopSession(other, 'cleanup')).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    expect((await stopSession(runtime, 'cleanup')).ok).toBe(true);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const state = (await runtime.resolveSessionContext('cleanup')).session;
    expect(state.artifacts.tracePath).toBeTruthy();
    expect((await readFile(path.join(root, state.artifacts.tracePath!))).length).toBeGreaterThan(0);
    expect((await stopSession(other, 'cleanup')).ok).toBe(true);
  } finally {
    fault.enabled = false;
    await stopSession(runtime, 'cleanup').catch(() => undefined);
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
  }
}, 20000);

it('retains finalized trace and event flush ownership until a failed sink flush can retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-scratch-owner-')); roots.push(root);
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: new ArtifactStore({ repoRoot: root }) });
  const options = { sessionId: 'flush', runId: 'flush', browser: 'chromium' as const, deterministic: { enabled: false, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 0 }, trace: { enabled: true } };
  try {
    const started = await runner.startSession(options);
    await started.page.setContent('<body>Retained trace</body>');
    vi.spyOn(started.eventCapture, 'flush').mockRejectedValueOnce(new Error('Injected sink flush failure'));
    await expect(runner.stopSession('flush')).rejects.toMatchObject({ code: 'E_BROWSER_LAUNCH_FAILED', details: { cleanupPending: true } });
    expect(started.page.context().browser()!.isConnected()).toBe(false);
    expect(runner.hasSession('flush')).toBe(true);
    await expect(runner.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    const closed = await runner.stopSession('flush');
    expect(closed.tracePath).toBeTruthy();
    expect((await readFile(path.join(root, closed.tracePath!))).length).toBeGreaterThan(0);
    expect(runner.hasSession('flush')).toBe(false);
  } finally { await runner.stopSession('flush').catch(() => undefined); }
}, 20000);

const tracedOptions = { sessionId: 'trace-retry', runId: 'trace-retry', browser: 'chromium' as const, deterministic: { enabled: false, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 0 }, trace: { enabled: true } };
it('retains an admitted final trace across repeated scratch removal failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-trace-retry-')); roots.push(root);
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: new ArtifactStore({ repoRoot: root }) });
  try {
    await runner.startSession(tracedOptions); fault.trace = true; fault.enabled = true;
    await expect(runner.stopSession(tracedOptions.sessionId)).rejects.toMatchObject({ details: { cleanupPending: true } });
    expect(runner.hasSession(tracedOptions.sessionId)).toBe(true);
    await expect(runner.stopSession(tracedOptions.sessionId)).rejects.toMatchObject({ details: { cleanupPending: true } });
    fault.enabled = false;
    const receipt = await runner.stopSession(tracedOptions.sessionId);
    expect(receipt.tracePath).toBeTruthy();
    expect((await readFile(path.join(root, receipt.tracePath!))).subarray(0, 2).toString()).toBe('PK');
    expect(runner.hasSession(tracedOptions.sessionId)).toBe(false);
    for (const directory of fault.paths) await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { fault.enabled = false; await runner.stopSession(tracedOptions.sessionId).catch(() => undefined); }
});
it.each(['scratch', 'restart'] as const)('returns the admitted chunk on retry before capturing a new chunk (%s)', async failure => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-trace-chunk-retry-')); roots.push(root);
  const store = new ArtifactStore({ repoRoot: root });
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: store });
  try {
    const started = await runner.startSession(tracedOptions);
    const tracing = started.page.context().tracing;
    const stop = vi.spyOn(tracing, 'stopChunk');
    const restart = vi.spyOn(tracing, 'startChunk');
    if (failure === 'restart') restart.mockRejectedValueOnce(new Error('Injected restart failure'));
    else { fault.trace = true; fault.enabled = true; }
    const first = path.posix.join(path.posix.dirname(store.getRunPaths(tracedOptions.runId).tracePath), 'first.zip');
    const second = first.replace('first.zip', 'second.zip');
    const failureResult = await runner.flushTrace(tracedOptions.sessionId, first).catch(error => error);
    expect(toErrorEnvelope(failureResult)).toMatchObject({ error: { code: 'E_STORAGE_WRITE_FAILED', retryable: true, details: { tracePath: first } } });
    expect((await readFile(path.join(root, first))).subarray(0, 2).toString()).toBe('PK');
    if (failure === 'restart') restart.mockRejectedValueOnce(new Error('Repeated restart failure'));
    const repeated = await runner.flushTrace(tracedOptions.sessionId, second).catch(error => error);
    expect(toErrorEnvelope(repeated)).toMatchObject({ error: { code: 'E_STORAGE_WRITE_FAILED', retryable: true, details: { tracePath: first } } });
    fault.enabled = false;
    expect(await runner.flushTrace(tracedOptions.sessionId, second)).toBe(first);
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(stat(path.join(root, second))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runner.flushTrace(tracedOptions.sessionId, second)).toBe(second);
    expect(stop).toHaveBeenCalledTimes(2);
    await runner.stopSession(tracedOptions.sessionId);
  } finally { fault.enabled = false; await runner.stopSession(tracedOptions.sessionId).catch(() => undefined); }
});

it('does not replace scratch ownership when trace stopping and scratch cleanup both fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-trace-double-failure-')); roots.push(root);
  const store = new ArtifactStore({ repoRoot: root });
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: store });
  try {
    const started = await runner.startSession(tracedOptions);
    const stop = vi.spyOn(started.page.context().tracing, 'stopChunk').mockRejectedValueOnce(new Error('Injected stop failure'));
    const finalize = vi.spyOn(started.page.context().tracing, 'stop');
    fault.trace = true; fault.enabled = true;
    await expect(runner.flushTrace(tracedOptions.sessionId, store.getRunPaths(tracedOptions.runId).tracePath)).rejects.toThrow();
    const directory = fault.paths[0]!;
    await expect(runner.flushTrace(tracedOptions.sessionId, store.getRunPaths(tracedOptions.runId).tracePath)).rejects.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(runner.stopSession(tracedOptions.sessionId)).rejects.toMatchObject({ details: { cleanupPending: true } });
    expect(finalize).not.toHaveBeenCalled();
    expect(new Set(fault.paths)).toEqual(new Set([directory]));
    expect(runner.hasSession(tracedOptions.sessionId)).toBe(true);
    fault.enabled = false;
    await runner.stopSession(tracedOptions.sessionId);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runner.hasSession(tracedOptions.sessionId)).toBe(false);
  } finally { fault.enabled = false; await runner.stopSession(tracedOptions.sessionId).catch(() => undefined); }
});

it('persists the public runtime trace receipt after scratch cleanup retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-trace-runtime-')); roots.push(root);
  const app = createServer((_req, res) => res.end('<body>Trace ownership</body>'));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const runtime = new ProbefnRuntime(root), owner = { closed: false };
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { web: { mode: 'attach', name: 'web', url: `http://127.0.0.1:${address.port}` } }, deterministicDefaults: { networkIdleMs: 10 } })}`);
  try {
    await runtime.withTransport(owner, async () => {
      await startSessionFromConfig(runtime, { configPath: 'config.mjs', sessionId: 'cleanup', runId: 'cleanup' });
      await openPage(runtime, { sessionId: 'cleanup', url: `http://127.0.0.1:${address.port}` });
      fault.trace = true; fault.enabled = true;
      await expect(stopSession(runtime, 'cleanup')).rejects.toMatchObject({ details: { cleanupPending: true } });
      fault.enabled = false;
      expect((await stopSession(runtime, 'cleanup')).ok).toBe(true);
      const state = (await runtime.resolveSessionContext('cleanup')).session;
      expect(state.artifacts.tracePath).toBeTruthy();
      expect((await readFile(path.join(root, state.artifacts.tracePath!))).subarray(0, 2).toString()).toBe('PK');
    });
  } finally { fault.enabled = false; await runtime.closeTransport(owner); app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
});

it('keeps the cap error and marks a stopped but unadmitted chunk inactive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-trace-import-failure-')); roots.push(root);
  const store = new ArtifactStore({ repoRoot: root });
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: store });
  try {
    const started = await runner.startSession(tracedOptions);
    const stop = vi.spyOn(started.page.context().tracing, 'stopChunk');
    vi.spyOn(store, 'importArtifactFile').mockRejectedValueOnce(createProbefnError({ code: 'E_STORAGE_CAP_EXCEEDED', message: 'Injected cap failure', details: { limit: 1 } }));
    const failure = await runner.flushTrace(tracedOptions.sessionId, store.getRunPaths(tracedOptions.runId).tracePath).catch(error => error);
    expect(toErrorEnvelope(failure)).toMatchObject({ error: { code: 'E_STORAGE_CAP_EXCEEDED', retryable: false, details: { limit: 1 } } });
    await expect(runner.flushTrace(tracedOptions.sessionId, store.getRunPaths(tracedOptions.runId).tracePath)).rejects.toMatchObject({ code: 'E_SESSION_NOT_FOUND' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await runner.stopSession(tracedOptions.sessionId)).tracePath).toBeNull();
  } finally { await runner.stopSession(tracedOptions.sessionId).catch(() => undefined); }
});
