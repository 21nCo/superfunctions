import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { BrowserRunner } from '@probefn/browser-runner';
import { ProbefnRuntime, runFlow, startSessionFromConfig, stopSession, createCheckpointFromSession } from '../src/server.js';

const form = `<html><body><input id="name"><button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value+':'+(++window.count)">Submit</button><p id="result">Waiting</p><script>window.count=0</script></body></html>`;

async function fixture(html = form, maxArtifactBytes = 2 * 1024 * 1024) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-live-flow-'));
  const app = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const runtime = new ProbefnRuntime(root);
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({
    projectName: 'flow', storageCaps: { maxArtifactBytes },
    devServers: { web: { mode: 'attach', name: 'web', url } }, deterministicDefaults: { networkIdleMs: 10 },
  })}`);
  await startSessionFromConfig(runtime, { configPath: 'config.mjs', sessionId: 'flow', runId: 'flow' });
  return {
    root, url, runtime,
    async steps(steps: object[]) { await writeFile(path.join(root, 'flow.json'), JSON.stringify({ version: 1, steps })); },
    async json(relative: string) { return JSON.parse(await readFile(path.join(root, relative), 'utf8')); },
    async close() {
      await stopSession(runtime, 'flow');
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('keeps transient form state, hashes the finalized trace, and preserves prior flow traces', async () => {
  const f = await fixture();
  try {
    await f.steps([
      { command: 'page.open', url: f.url },
      { command: 'page.act', action: 'fill', selector: '#name', value: 'Ada' },
      { command: 'page.act', action: 'click', selector: '#submit' },
      { command: 'checkpoint.create', name: 'after', includeTrace: true },
      { command: 'report.export', format: 'json' },
    ]);
    expect((await runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' })).ok).toBe(true);
    expect((await f.json('.artifacts/runs/flow/checkpoints/after/dom.json')).html).toContain('<p id="result">Ada:1</p>');
    const report = await f.json('.artifacts/runs/flow/report.json');
    expect(report.tracePath).toBeTypeOf('string');
    const trace = await readFile(path.join(f.root, report.tracePath));
    const manifest = await f.json('.artifacts/runs/flow/checkpoints/after/checkpoint.json');
    expect(manifest.artifacts).toContainEqual({ kind: 'trace', path: report.tracePath, sha256: createHash('sha256').update(trace).digest('hex') });
    const entries = execFileSync('unzip', ['-Z1', path.join(f.root, report.tracePath)], { encoding: 'utf8' });
    expect(entries).toContain('trace.trace');
    const events = execFileSync('unzip', ['-p', path.join(f.root, report.tracePath), 'trace.trace'], { encoding: 'utf8' });
    expect(events).toContain('Ada');
    expect(events).toContain('#submit');
    await f.steps([{ command: 'page.open', url: f.url }, { command: 'report.export', format: 'json' }]);
    await runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' });
    expect((await f.json('.artifacts/runs/flow/report.json')).tracePath).not.toBe(report.tracePath);
    expect(await readFile(path.join(f.root, report.tracePath))).toEqual(trace);
  } finally { await f.close(); }
});

it('rejects an unavailable requested trace explicitly', async () => {
  const f = await fixture();
  try {
    await expect(createCheckpointFromSession(f.runtime, { sessionId: 'flow', name: 'missing', includeTrace: true }))
      .rejects.toMatchObject({ code: 'E_CHECKPOINT_CAPTURE_FAILED' });
    await expect(readFile(path.join(f.root, '.artifacts/runs/flow/checkpoints/missing/checkpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
});

it.each(['request', 'session-stop'] as const)('cancels a blocked live flow via %s, closes its browser, and rejects overlap', async (method) => {
  const f = await fixture();
  const start = BrowserRunner.prototype.startSession;
  let started!: (value: Awaited<ReturnType<typeof start>>) => void;
  const ready = new Promise<Awaited<ReturnType<typeof start>>>(resolve => { started = resolve; });
  const spy = vi.spyOn(BrowserRunner.prototype, 'startSession').mockImplementation(async function (this: BrowserRunner, options) {
    const value = await start.call(this, options); started(value); return value;
  });
  const controller = new AbortController();
  let pending: ReturnType<ProbefnRuntime['callTool']> | undefined;
  try {
    await f.steps([{ command: 'page.act', action: 'click', selector: '#never-present' }]);
    pending = f.runtime.callTool('probefn_run_flow', { sessionId: 'flow', file: 'flow.json' }, controller.signal);
    const browser = (await ready).page.context().browser()!;
    await expect(runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    if (method === 'request') controller.abort(new Error('Owned test cancellation'));
    else await stopSession(f.runtime, 'flow');
    expect((await pending).isError).toBe(true);
    expect(browser.isConnected()).toBe(false);
    await f.steps([{ command: 'page.open', url: f.url }]);
    expect((await runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' })).ok).toBe(true);
  } finally { controller.abort(); await pending; spy.mockRestore(); await f.close(); }
});

it('fails trace admission at the persisted run cap without returning a successful report', async () => {
  const f = await fixture(`<html><body>${randomBytes(180000).toString('base64')}</body></html>`, 65536);
  const start = BrowserRunner.prototype.startSession;
  let browser: ReturnType<Awaited<ReturnType<typeof start>>['page']['context']> | undefined;
  const spy = vi.spyOn(BrowserRunner.prototype, 'startSession').mockImplementation(async function (this: BrowserRunner, options) {
    const value = await start.call(this, options); browser = value.page.context(); return value;
  });
  try {
    await f.steps([{ command: 'report.export', format: 'json' }]);
    await expect(runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
    expect(browser?.browser()?.isConnected()).toBe(false);
    expect((await f.runtime.resolveSessionContext('flow')).session.artifacts.tracePath).toBeFalsy();
    await expect(readFile(path.join(f.root, '.artifacts/runs/flow/report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { spy.mockRestore(); await f.close(); }
});

it('does not start a flow over an already owned standalone playback', async () => {
  const f = await fixture();
  let release!: () => void;
  let acquired!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const { session } = await f.runtime.resolveSessionContext('flow');
  const playback = f.runtime.withPlaybackSession(session, async () => { acquired(); await hold; });
  try {
    await ready;
    await f.steps([{ command: 'page.open', url: f.url }]);
    await expect(runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    release();
    await playback;
    expect((await runFlow(f.runtime, { sessionId: 'flow', file: 'flow.json' })).ok).toBe(true);
  } finally { release(); await playback; await f.close(); }
});
