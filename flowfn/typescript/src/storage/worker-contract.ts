import { expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FlowAdapter } from '../adapters/base.js';
import { createFlow } from '../core/flow-fn.js';
import { createWorker } from '../queue/worker.js';
import { createWorkerPool } from '../queue/worker-pool.js';

function ownedFlow(adapter: FlowAdapter) {
  const binding = new Proxy(adapter, { get(target, key) { const value = Reflect.get(target, key); return key === 'cleanup' ? async () => {} : typeof value === 'function' ? value.bind(target) : value; } });
  return createFlow({ adapter: binding, namespace: randomUUID() });
}
export async function workerOwnershipContract(adapter: FlowAdapter, leaseDuration = 120) {
  const flow = ownedFlow(adapter);
  const queue = flow.queue('work');
  const settings = { lockDuration: leaseDuration, lockRenewTime: Math.floor(leaseDuration / 4), stalledInterval: 10, maxStalledCount: 1 };
  const first = createWorker({ flow, queues: ['work'], settings, shutdownTimeout: 20 });
  const second = createWorker({ flow, queues: ['work'], settings });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = vi.fn(async () => { await blocked; return 'stale'; });
  const replacement = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, leaseDuration * 2 + 20)); return 'replacement'; });
  first.register('work', original); second.register('work', replacement);
  try {
    const job = await queue.add('job', {});
    await first.run();
    await vi.waitFor(() => expect(original).toHaveBeenCalledTimes(1));
    await expect(first.close()).rejects.toThrow('shutdown timed out');
    await second.run();
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledTimes(1), { timeout: Math.max(3000, leaseDuration * 5) });
    release();
    await queue.drain();
    expect((await queue.getJob(job.id))?.returnvalue).toBe('replacement');
    expect((await queue.getJob(job.id))?.stalledCount).toBe(1);
    await second.close();
    expect((await queue.add('after-close', {})).state).toBe('waiting');
  } finally { release(); await first.close().catch(() => undefined); await second.close(); await flow.close(); }
}

export async function workerPoolContract(adapter: FlowAdapter) {
  const flow = ownedFlow(adapter);
  const pool = createWorkerPool({ flow, queues: ['tasks'], minWorkers: 1, maxWorkers: 3, scaleUpThreshold: 1, scaleDownDelay: 20, pollInterval: 10, workerOptions: { concurrency: 1 } });
  let release!: () => void, active = 0, maximum = 0, completed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  pool.register('tasks', async () => { active++; maximum = Math.max(maximum, active); await gate; active--; return true; });
  pool.on('completed', () => { completed++; });
  try {
    await pool.start();
    await flow.queue('tasks').addBulk(Array.from({ length: 8 }, () => ({ name: 'job', data: {} })));
    await vi.waitFor(async () => expect(await pool.getStats()).toMatchObject({ activeWorkers: 3, activeJobs: 3 }), { timeout: 3000 });
    release();
    await flow.queue('tasks').drain();
    expect(maximum).toBe(3);
    expect(completed).toBe(8);
    await vi.waitFor(async () => expect((await pool.getStats()).activeWorkers).toBe(1), { timeout: 3000 });
    await pool.close();
    expect((await flow.queue('tasks').add('after-pool', {})).state).toBe('waiting');
  } finally { release(); await pool.close(); await flow.close(); }
}
