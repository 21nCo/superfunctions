import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserRunner } from '@probefn/browser-runner';
import { SessionManager } from '@probefn/core';
import { ArtifactStore } from '@probefn/storage';
import { ProbefnRuntime, ProbefnMcpServer, exportSessionReport, startSessionFromConfig, openPage } from '../src/server.js';

it('keeps a transport-owned live page across separate MCP calls and fences another runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-resident-'));
  const app = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<input id="name"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value+':'+(++window.counter)">Save</button><p id="result">Waiting</p><script>window.counter=0</script>`); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url } }, deterministicDefaults: { networkIdleMs: 10 } })}`);
  const runtime = new ProbefnRuntime(root);
  const server = new ProbefnMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = server.serveTransport(serverTransport);
  const client = new Client({ name: 'resident-acceptance', version: '1' });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    return result.structuredContent;
  }
  try {
    await client.connect(clientTransport);
    await call('probefn_session_start', { configPath: 'config.mjs', sessionId: 'live', runId: 'live' });
    await call('probefn_page_open', { sessionId: 'live', url });
    await call('probefn_page_act', { sessionId: 'live', action: 'fill', selector: '#name', value: 'Ada' });
    await call('probefn_page_act', { sessionId: 'live', action: 'click', selector: '#save' });
    await call('probefn_checkpoint_create', { sessionId: 'live', name: 'state', includeTrace: true });
    const dom = JSON.parse(await readFile(path.join(root, '.artifacts/runs/live/checkpoints/state/dom.json'), 'utf8'));
    expect(dom.html).toContain('<p id="result">Ada:1</p>');
    await expect(exportSessionReport(new ProbefnRuntime(root), { sessionId: 'live', format: 'json' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    await call('probefn_report_export', { sessionId: 'live', format: 'json' });
    const report = JSON.parse(await readFile(path.join(root, '.artifacts/runs/live/report.json'), 'utf8'));
    expect(report.tracePaths.length).toBeGreaterThanOrEqual(4);
    for (const trace of report.tracePaths) expect((await readFile(path.join(root, trace))).subarray(0,2).toString()).toBe('PK');
    await client.close(); await serving;
    const state = JSON.parse(await readFile(path.join(root, '.artifacts/session-state/live.json'), 'utf8'));
    expect(state.status).toBe('completed');
    expect((await exportSessionReport(new ProbefnRuntime(root), { sessionId: 'live', format: 'json' })).ok).toBe(true);
  } finally {
    await client.close(); await serving;
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('isolates connection ownership and closes only the departing client browser', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-resident-clients-'));
  const app = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<input id="name"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value+':'+(++window.counter)">Save</button><p id="result">Waiting</p><script>window.counter=0</script>`); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url } }, deterministicDefaults: { networkIdleMs: 10 } })}`);
  const runtime = new ProbefnRuntime(root);
  const server = new ProbefnMcpServer(runtime);
  const clients: Client[] = [];
  const servings: Promise<void>[] = [];
  async function connect(name: string) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    servings.push(server.serveTransport(serverTransport));
    const client = new Client({ name, version: '1' }); clients.push(client);
    await client.connect(clientTransport); return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    return result;
  }
  try {
    const a = await connect('a'); const b = await connect('b');
    for (const [client, sessionId] of [[a, 'a'], [b, 'b']] as const) {
      await call(client, 'probefn_session_start', { configPath: 'config.mjs', sessionId, runId: sessionId });
      await call(client, 'probefn_page_open', { sessionId, url });
      await call(client, 'probefn_page_act', { sessionId, action: 'fill', selector: '#name', value: sessionId });
      await call(client, 'probefn_page_act', { sessionId, action: 'click', selector: '#save' });
    }
    const denied = await b.callTool({ name: 'probefn_session_stop', arguments: { sessionId: 'a' } });
    expect(denied.isError).toBe(true);
    expect((denied.structuredContent as { error: { code: string } }).error.code).toBe('E_SESSION_ALREADY_RUNNING');
    await a.close(); await servings[0];
    await call(b, 'probefn_page_act', { sessionId: 'b', action: 'click', selector: '#save' });
    await call(b, 'probefn_checkpoint_create', { sessionId: 'b', name: 'still-live', includeTrace: true });
    expect(JSON.parse(await readFile(path.join(root, '.artifacts/runs/b/checkpoints/still-live/dom.json'), 'utf8')).html).toContain('<p id="result">b:2</p>');
    await b.close(); await servings[1];
    for (const id of ['a', 'b']) expect(JSON.parse(await readFile(path.join(root, `.artifacts/session-state/${id}.json`), 'utf8')).status).toBe('completed');
  } finally {
    for (const client of clients) await client.close();
    await Promise.all(servings);
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('cancels a real stalled navigation and joins browser cleanup on transport close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-resident-cancel-'));
  let stalled!: () => void;
  const requested = new Promise<void>(resolve => { stalled = resolve; });
  const app = createServer((req, res) => {
    if (req.url === '/slow') { stalled(); return; }
    res.setHeader('content-type', 'text/html'); res.end('<p>Ready</p>');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url } }, deterministicDefaults: { networkIdleMs: 10 } })}`);
  const runtime = new ProbefnRuntime(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = new ProbefnMcpServer(runtime).serveTransport(serverTransport);
  const client = new Client({ name: 'cancel-acceptance', version: '1' });
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    await client.connect(clientTransport);
    const started = await client.callTool({ name: 'probefn_session_start', arguments: { configPath: 'config.mjs', sessionId: 'live', runId: 'live' } });
    expect(started.isError).toBe(false);
    pending = client.callTool({ name: 'probefn_page_open', arguments: { sessionId: 'live', url: `${url}/slow` } }, undefined, { signal: controller.signal });
    void pending.catch(() => undefined);
    await requested;
    controller.abort(new Error('Owned navigation cancelled'));
    await expect(pending).rejects.toThrow();
    await client.close(); await serving;
    const state = JSON.parse(await readFile(path.join(root, '.artifacts/session-state/live.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(root, '.artifacts/runs/live/session.json'), 'utf8'));
    expect(state.status).toBe('failed'); expect(manifest.status).toBe('failed');
    expect((await exportSessionReport(new ProbefnRuntime(root), { sessionId: 'live', format: 'json' })).ok).toBe(true);
  } finally {
    controller.abort(); await pending?.catch(() => undefined);
    await client.close(); await serving;
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('reports pending cleanup without releasing authority while browser close is held', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-resident-held-close-'));
  const app = createServer((_req, res) => res.end('<p>Ready</p>'));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url } }, deterministicDefaults: { networkIdleMs: 10 } })}`);
  const runtime = new ProbefnRuntime(root, undefined, { cleanupTimeoutMs: 100 });
  const owner = { closed: false };
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const original = BrowserRunner.prototype.stopSession;
  let spy: { mockRestore(): void } | undefined;
  try {
    await runtime.withTransport(owner, async () => {
      await startSessionFromConfig(runtime, { configPath: 'config.mjs', sessionId: 'live', runId: 'live' });
      await openPage(runtime, { sessionId: 'live', url });
    });
    spy = vi.spyOn(BrowserRunner.prototype, 'stopSession').mockImplementation(async function (this: BrowserRunner, ...args) {
      await hold; return original.apply(this, args);
    });
    await expect(runtime.closeTransport(owner)).rejects.toMatchObject({ details: { cleanupPending: true, cleanupTimeoutMs: 100 } });
    await expect(exportSessionReport(new ProbefnRuntime(root), { sessionId: 'live', format: 'json' })).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
    release();
    await expect.poll(async () => JSON.parse(await readFile(path.join(root, '.artifacts/session-state/live.json'), 'utf8')).status, { timeout: 3000 }).toBe('completed');
    await runtime.closeTransport(owner);
    expect((await exportSessionReport(new ProbefnRuntime(root), { sessionId: 'live', format: 'json' })).ok).toBe(true);
  } finally {
    release(); spy?.mockRestore();
    await runtime.closeTransport(owner);
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


it('keeps closed transport state local and fences operations resumed after closure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-transport-retention-'));
  const runtime = new ProbefnRuntime(root);
  try {
    for (let index = 0; index < 1000; index++) {
      const transport = { closed: false };
      await runtime.closeTransport(transport);
      expect(transport.closed).toBe(true);
      await expect(runtime.withTransport(transport, () => runtime.withSessionOperation('unused', async () => undefined))).rejects.toThrow('closing');
    }
    expect(Reflect.get(runtime, 'transportCleanup').size).toBe(0);
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const transport = { closed: false };
    const late = runtime.withTransport(transport, async () => {
      await hold;
      return runtime.withSessionOperation('unused', async () => undefined);
    });
    await runtime.closeTransport(transport);
    resume();
    await expect(late).rejects.toThrow('closing');
  } finally { await rm(root, { recursive: true, force: true }); }
});


it('cleans the dev-server owner after session-state initialization fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probe-start-state-failure-'));
  const app = createServer((_req, res) => res.end('ready'));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url } } })}`);
  const runtime = new ProbefnRuntime(root);
  const transport = { closed: false };
  const failure = vi.spyOn(SessionManager.prototype, 'initialize').mockRejectedValueOnce(new Error('state storage failed'));
  try {
    await expect(runtime.withTransport(transport, () => startSessionFromConfig(runtime, { configPath: 'config.mjs', sessionId: 'live', runId: 'live' }))).rejects.toThrow('state storage failed');
    failure.mockRestore();
    await runtime.closeTransport(transport);
    await expect(readFile(path.join(root, '.artifacts/session-state/live.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await new ArtifactStore({ repoRoot: root }).writeArtifact('.artifacts/runs/live/after-cleanup.txt', 'released');
  } finally {
    failure.mockRestore(); await runtime.closeTransport(transport);
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
