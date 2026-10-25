import { describe, it, expect } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { QueueImpl } from './queue.js';
import { JobImpl } from './job.js';
import { createFlow } from '../core/flow-fn.js';
import { createWorker } from './worker.js';

describe('queue ownership', () => {
  it.each(['save', 'ack', 'nack', 'enqueue', 'recover'] as const)('omits cleared leases from public snapshots after %s and rejects the old token', async transition => {
    const adapter = new MemoryAdapter();
    const original = new JobImpl('job', { nested: { value: 1 } });
    await adapter.createJob('lease-snapshots', original);
    const owned = (await adapter.dequeue('lease-snapshots', undefined, transition === 'recover' ? 1 : 30_000))!;
    const token = owned.lease!.token;
    if (transition === 'save') {
      owned.state = 'completed';
      await adapter.saveJob('lease-snapshots', owned);
    } else if (transition === 'ack') await adapter.ack('lease-snapshots', owned.id, token);
    else if (transition === 'nack') await adapter.nack('lease-snapshots', owned.id, true, token);
    else if (transition === 'enqueue') await adapter.enqueue('lease-snapshots', owned);
    else {
      await new Promise(resolve => setTimeout(resolve, 5));
      const recovered = await adapter.recoverStalledJobs('lease-snapshots', 1);
      expect(recovered).toHaveLength(1);
      expect(Object.hasOwn(recovered[0]!, 'lease')).toBe(false);
    }
    const current = (await adapter.getJob('lease-snapshots', owned.id))!;
    expect(Object.hasOwn(current, 'lease')).toBe(false);
    expect((await adapter.getAllJobs('lease-snapshots')).every(job => !Object.hasOwn(job, 'lease'))).toBe(true);
    current.data.nested.value = 9;
    expect((await adapter.getJob('lease-snapshots', owned.id))!.data.nested.value).toBe(1);
    await expect(adapter.ack('lease-snapshots', owned.id, token)).rejects.toThrow('lease lost');
  });
  it('atomically deduplicates queue instances and keeps namespaces separate', async () => {
    const adapter = new MemoryAdapter();
    const a = createFlow({ adapter, namespace: 'a' });
    const b = createFlow({ adapter, namespace: 'b' });
    try {
      const queues = Array.from({ length: 10 }, () => new QueueImpl('shared', adapter));
      const jobs = await Promise.all(queues.map(queue => queue.add('job', {}, { deduplicationKey: 'once' })));
      expect(new Set(jobs.map(job => job.id)).size).toBe(1);
      const first = await a.queue('work').add('job', 1, { jobId: 'id' });
      const second = await b.queue('work').add('job', 2, { jobId: 'id' });
      expect(first.data).toBe(1);
      expect(second.data).toBe(2);
      await Promise.all(queues.map(queue => queue.close()));
    } finally { await a.close(); await b.close(); }
  });
  it('recovers abandoned claims through worker settings and emits stalled', async () => {
    const adapter = new MemoryAdapter();
    const original = new JobImpl('job', {});
    await adapter.createJob('work', original);
    const stale = (await adapter.dequeue('work', undefined, 10))!;
    await new Promise(resolve => setTimeout(resolve, 20));
    const flow = createFlow({ adapter });
    const worker = createWorker({ flow, queues: ['work'], settings: { leaseDuration: 100, stalledInterval: 5, maxStalledCount: 1 } });
    let stalls = 0;
    worker.on('stalled', () => stalls++);
    worker.register('work', async () => { await new Promise(resolve => setTimeout(resolve, 220)); return 'done'; });
    try {
      await worker.run();
      await flow.queue('work').drain();
      expect(stalls).toBe(1);
      expect((await flow.queue('work').getJob(original.id))?.returnvalue).toBe('done');
      await expect(adapter.saveJob('work', stale)).rejects.toThrow('lease lost');
      await expect(adapter.enqueue('work', stale)).rejects.toThrow('lease lost');
    } finally { await worker.close(); await flow.close(); }
  });
  it('preserves failed state when a newer job owns the retry key', async () => {
    const queue = new QueueImpl('keys', new MemoryAdapter());
    try {
      const first = await queue.add('work', {}, { deduplicationKey: 'key' });
      await first.moveToFailed(new Error('original'));
      const next = await queue.add('work', {}, { deduplicationKey: 'key' });
      await expect(first.retry()).rejects.toThrow('deduplication key');
      expect(first.state).toBe('failed');
      expect(first.failedReason).toBe('original');
      expect((await queue.getJob(next.id))?.state).toBe('waiting');
    } finally { await queue.close(); }
  });
  it('retries a transient renewal error within the confirmed lease deadline', async () => {
    const adapter = new MemoryAdapter();
    const renew = adapter.renewJobLease.bind(adapter);
    let attempts = 0;
    adapter.renewJobLease = async (...args) => {
      if (attempts++ === 0) throw new Error('temporary transport failure');
      return renew(...args);
    };
    const queue = new QueueImpl('transient-renewal', adapter, { leaseDuration: 180, stalledInterval: 20 });
    try {
      const job = await queue.add('work', {});
      queue.process(async () => { await new Promise(resolve => setTimeout(resolve, 450)); return 'done'; });
      await queue.drain();
      expect(attempts).toBeGreaterThan(1);
      expect((await queue.getJob(job.id))?.returnvalue).toBe('done');
      expect((await queue.getJob(job.id))?.stalledCount ?? 0).toBe(0);
    } finally { await queue.close(); }
  });
  it('aborts at the confirmed deadline even when renewal never settles', async () => {
    const adapter = new MemoryAdapter();
    adapter.renewJobLease = () => new Promise<boolean>(() => undefined);
    const queue = new QueueImpl('hung-renewal', adapter, { leaseDuration: 60, stalledInterval: 10, maxStalledCount: 0 });
    let aborted = false;
    try {
      const job = await queue.add('work', {});
      queue.process(async active => {
        await new Promise<void>(resolve => active.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
        return 'stale result';
      });
      await queue.drain();
      expect(aborted).toBe(true);
      expect((await queue.getJob(job.id))?.state).toBe('failed');
      expect((await queue.getJob(job.id))?.returnvalue).toBeUndefined();
    } finally { await queue.close(); }
  });
  it('rejects invalid lease settings before processing', () => {
    expect(() => new QueueImpl('work', new MemoryAdapter(), { leaseDuration: 0 })).toThrow('leaseDuration');
    expect(() => new QueueImpl('work', new MemoryAdapter(), { maxStalledCount: -1 })).toThrow('maxStalledCount');
  });
});
