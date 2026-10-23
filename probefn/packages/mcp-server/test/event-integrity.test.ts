import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProbefnRuntime, startSessionFromConfig, stopSession, openPage } from '../src/server.js';

it.each([false, true])('finalizes rejected event capture as failed, even if previously completed=%s', async completed => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-event-stop-'));
  const app = createServer((_request, response) => { response.end('ready'); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url: `http://127.0.0.1:${address.port}` } } })}`);
  const runtime = new ProbefnRuntime(root);
  const owner = { closed: false };
  try {
    await runtime.withTransport(owner, async () => {
      await startSessionFromConfig(runtime, { configPath: 'config.mjs', sessionId: 'session', runId: 'run' });
      await openPage(runtime, { sessionId: 'session', url: `http://127.0.0.1:${address.port}` });
    });
    await runtime.withTransport(owner, () => runtime.withSessionOperation('session', async () => {
      const { scope } = await runtime.resolveSessionContext('session');
      if (completed) await scope.sessionManager.markCompleted('session');
      const sink = scope.artifactStore.createEventSink('run', 'console', 'events', { policy: { maxEventsPerSink: 1, strategy: 'error' } });
      await sink.append({ message: 'first' });
      await expect(sink.append({ message: 'rejected' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
      await expect(scope.sessionManager.markCompleted('session')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
    }));
    const stopped = await runtime.withTransport(owner, () => stopSession(runtime, 'session'));
    expect(stopped).toMatchObject({ ok: true, data: { status: 'failed' } });
    expect(JSON.parse(await readFile(path.join(root, '.artifacts/runs/run/session.json'), 'utf8'))).toMatchObject({ status: 'failed', endedAt: expect.any(String) });
    const state = JSON.parse(await readFile(path.join(root, '.artifacts/session-state/session.json'), 'utf8'));
    expect(state).toMatchObject({ status: 'failed' });
    expect(state.artifacts.tracePaths.length).toBeGreaterThanOrEqual(2);
    for (const tracePath of state.artifacts.tracePaths as string[]) expect((await readFile(path.join(root, tracePath))).subarray(0, 2).toString()).toBe('PK');
  } finally {
    await runtime.withTransport(owner, () => runtime.withSessionOperation('session', async () => { const { scope } = await runtime.resolveSessionContext('session'); await scope.sessionManager.markFailed('session'); })).catch(() => undefined);
    await runtime.closeTransport(owner); app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
