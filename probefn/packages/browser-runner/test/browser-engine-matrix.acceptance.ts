import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { firefox, webkit } from 'playwright';
import { ArtifactStore } from '@probefn/storage';
import { BrowserRunner } from '../src/browser-runner.js';
import { performPageAction } from '../src/actions.js';

it.each(['firefox', 'webkit'] as const)('%s captures real actions, events and a finalized trace', async browser => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-browser-matrix-'));
  const server = createServer((request, response) => {
    if (request.url === '/failure') { response.writeHead(500); response.end('failed'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<button id="trigger" onclick="console.error(\'matrix-error\');fetch(\'/failure\');this.textContent=\'Finished\'">Execute</button>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new ArtifactStore({ repoRoot: root });
  const runner = new BrowserRunner({ repoRoot: root, artifactStore: store });
  let started: Awaited<ReturnType<BrowserRunner['startSession']>> | undefined;
  let stopped = false;
  let stage = 'launch';
  const engine = browser === 'firefox' ? firefox : webkit;
  const launch = engine.launch.bind(engine);
  const launchSpy = vi.spyOn(engine, 'launch').mockImplementation(async options => {
    const instance = await launch({ ...options, timeout: 10_000 });
    stage = 'context, tracing and initial navigation';
    return instance;
  });
  try {
    started = await runner.startSession({ sessionId: 'matrix', runId: 'matrix', browser,
      deterministic: { enabled: true, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC',
        colorScheme: 'light', reducedMotion: 'reduce', animationPolicy: 'freeze', networkIdleMs: 25 },
      initialUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, trace: { enabled: true } });
    stage = 'action and event settlement';
    const result = await performPageAction({ repoRoot: root, page: started.page,
      action: { kind: 'click', target: { selector: '#trigger' } }, eventPaths: started.sinkPaths,
      flushEvents: () => started!.eventCapture.flush(), networkIdleMs: 25, settleTimeoutMs: 3000 });
    expect(result.newConsoleErrors).toBe(1);
    expect(result.newNetworkFailures).toBe(1);
    expect(await started.page.locator('#trigger').textContent()).toBe('Finished');
    stage = 'screenshot';
    const screenshot = await started.page.screenshot({ timeout: 10_000 });
    expect(screenshot.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    stage = 'trace finalization and browser cleanup';
    const closed = await runner.stopSession('matrix'); stopped = true;
    expect(closed.tracePath).toBeTruthy();
    const trace = await readFile(path.resolve(root, closed.tracePath!));
    expect(trace.subarray(0, 2).toString()).toBe('PK');
    expect(trace.length).toBeGreaterThan(100);
    expect(started.page.context().browser()?.isConnected()).toBe(false);
  } catch (error) {
    throw new Error(`${browser} acceptance failed during ${stage}`, { cause: error });
  } finally {
    launchSpy.mockRestore();
    try {
      if (started && !stopped) await runner.stopSession('matrix');
    } finally {
      server.closeAllConnections();
      try { await new Promise<void>(resolve => server.close(() => resolve())); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}, 45000);
