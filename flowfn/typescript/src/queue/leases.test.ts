import { describe, it, expect } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { QueueImpl } from './queue.js';
import { JobImpl } from './job.js';
import { createFlow } from '../core/flow-fn.js';
import { createWorker } from './worker.js';

describe('queue ownership', () => {
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
  it('rejects invalid lease settings before processing', () => {
    expect(() => new QueueImpl('work', new MemoryAdapter(), { leaseDuration: 0 })).toThrow('leaseDuration');
    expect(() => new QueueImpl('work', new MemoryAdapter(), { maxStalledCount: -1 })).toThrow('maxStalledCount');
  });
});
