import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore } from './runtime-store.js';
import type { DatabaseStore } from './database-store.js';
import { prepareRun } from '../dispatch/prepare.js';
import { MemorySecFnClient } from '../secrets/secfn-client.js';
import { createApp } from '../api/routes.js';
import { createControlPlaneServer } from '../http-server.js';
import { hashSecret } from '../runners/crypto.js';
import { logDigest, LOG_RETENTION_MS, type LogPacket, type RunnerLogEvent } from '../log-delivery/protocol.js';

const event: RunnerLogEvent = { ts: '2026-10-22T00:00:00.000Z', name: 'cifn', level: 'info', version: '0', msg: 'safe output', ctx: { stepKey: 'step-0' } };
const packet = (sequence: number, events = [event], terminal?: LogPacket['terminal']): LogPacket => {
  const value = { sequence, events, ...(terminal ? { terminal } : {}) }; return { ...value, digest: logDigest(value) };
};
afterEach(() => vi.restoreAllMocks());
it('authenticates log delivery, persists receipts before ACK, rejects replay conflicts and survives native SQLite reopen/expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cifn-logs-'));
  const env = { CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: Buffer.alloc(32, 14).toString('base64') };
  let runtime = await createRuntimeStore(env);
  let server: ReturnType<typeof createControlPlaneServer> | undefined;
  const closeServer = async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } };
  try {
    let store = runtime.store as DatabaseStore;
    const secrets = new MemorySecFnClient(); await secrets.setSecret('CIFN_API_KEYS', 'api'); await secrets.setSecret('TOKEN', 'pipeline-secret-content');
    const run = await store.createPreparedRun(await prepareRun({ trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.TOKEN }}' }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'printf safe' }] } } } }, secrets));
    const runner = await store.createRunner(['default'], hashSecret('runner-secret'));
    const dispatchId = JSON.stringify([run.id, 'build', 1]);
    const claim = await store.claimDispatch(run.id, dispatchId, runner.id, ['default']);
    const identity = { runId: run.id, dispatchId, runnerId: runner.id, claimToken: claim!.claimToken!, executionId: 'owner' };
    await store.acknowledgeDispatch(identity);
    async function start() {
      server = createControlPlaneServer(createApp({ store, secFn: secrets }).app);
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('No address'); return `http://127.0.0.1:${addr.port}`;
    }
    let base = await start();
    const send = (value: unknown, owner = identity, credential = 'runner-secret') => fetch(base + '/api/v1/runners/claims/logs', { method: 'POST', headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify({ ...owner, packet: value }) });
    const read = async () => (await (await fetch(base + `/api/v1/runs/${run.id}/jobs/build/logs`, { headers: { Authorization: 'Bearer api' } })).json()) as { data: { lines: unknown[]; transfer: { status: string } } };
    expect((await read()).data.transfer.status).toBe('pending');
    expect((await send(packet(0), identity, 'wrong')).status).toBe(401);
    for (const changed of [{ executionId: 'old' }, { runnerId: 'other' }, { claimToken: 'old' }]) expect((await send(packet(0), { ...identity, ...changed })).status).not.toBe(200);
    expect((await send(packet(1))).status).toBe(409);
    expect((await send({ ...packet(0), digest: '0'.repeat(64) })).status).toBe(400);
    expect((await send(packet(0, [{ ...event, msg: 'pipeline-secret-content' }]))).status).toBe(409);
    expect((await send(packet(0, [{ ...event, msg: 'x'.repeat(8193) }]))).status).toBe(400);
    expect((await send(packet(0))).status).toBe(200); // Deliberately discard response body (lost ACK).
    await closeServer(); await runtime.close(); runtime = await createRuntimeStore(env); store = runtime.store as DatabaseStore; base = await start();
    expect((await send(packet(0))).status).toBe(200);
    expect((await read()).data.lines).toHaveLength(1);
    expect((await send(packet(0, [{ ...event, msg: 'conflict' }]))).status).toBe(409);
    expect((await send(packet(1, [], 'complete'))).status).toBe(200);
    expect((await read()).data.transfer.status).toBe('complete');
    expect((await store.getRun(run.id))?.status).toBe('running');
    expect((await send(packet(2))).status).toBe(409);
    await closeServer(); await runtime.close();
    for (const file of await readdir(directory)) {
      const bytes = await readFile(join(directory, file));
      expect(bytes.includes(Buffer.from('pipeline-secret-content'))).toBe(false);
      expect(bytes.includes(Buffer.from('safe output'))).toBe(false);
    }
    runtime = await createRuntimeStore(env); store = runtime.store as DatabaseStore;
    const silentRun = await store.createPreparedRun(await prepareRun({ trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'true' }] } } } }, secrets));
    const silentDispatch = JSON.stringify([silentRun.id, 'build', 1]);
    const silentClaim = await store.claimDispatch(silentRun.id, silentDispatch, runner.id, ['default']);
    const silentIdentity = { runId: silentRun.id, dispatchId: silentDispatch, runnerId: runner.id, claimToken: silentClaim!.claimToken!, executionId: 'silent-owner' };
    await store.acknowledgeDispatch(silentIdentity);
    expect(await store.readDispatchLogs(silentRun.id, 'build')).toMatchObject({ lines: [], transfer: { status: 'pending' } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LOG_RETENTION_MS + 1);
    await store.purgeExpiredLogs();
    expect(await store.readDispatchLogs(run.id, 'build')).toMatchObject({ lines: [], transfer: { status: 'expired' } });
    expect((await store.getRun(run.id))?.status).toBe('running');
    expect(await store.readDispatchLogs(silentRun.id, 'build')).toMatchObject({ lines: [], transfer: { status: 'expired' } });
    expect(await store.appendDispatchLogs(silentIdentity, packet(0))).toMatchObject({ status: 'expired' });
    expect(await store.readDispatchLogs(silentRun.id, 'build')).toMatchObject({ lines: [], transfer: { status: 'expired' } });
    expect(await store.appendDispatchLogs(identity, packet(0))).toMatchObject({ status: 'expired' }); clock.mockRestore();
  } finally { await closeServer(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
