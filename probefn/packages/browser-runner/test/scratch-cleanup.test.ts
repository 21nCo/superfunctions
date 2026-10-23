import { createServer } from 'node:http';
import { ProbefnRuntime, startSessionFromConfig, createCheckpointFromSession, stopSession } from '@probefn/mcp-server';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { BrowserRunner } from '../src/browser-runner.js';
const fault = vi.hoisted(() => ({ enabled: false, paths: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
    if (fault.enabled && path.basename(String(args[0])).startsWith('probefn-video-')) { fault.paths.push(String(args[0])); throw new Error('owned scratch removal failed'); }
    return fs.rm(...args);
  } };
});
const roots: string[] = [], browsers: Browser[] = [];
afterEach(async () => {
  fault.enabled = false; vi.restoreAllMocks();
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
