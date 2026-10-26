import { describe, expect, it } from 'vitest';
import { MemoryQueueAdapter, QueueError } from '../index.js';
import { describeQueueContract, drainConcurrently } from './contract.js';

describeQueueContract('memory', async (now) => ({ queue: new MemoryQueueAdapter({ now }) }));

describe('MemoryQueueAdapter', () => {
  it('rejects enqueue once maxSize live jobs exist and frees a slot on ack', async () => {
    const queue = new MemoryQueueAdapter<string>({ maxSize: 2 });
    await queue.enqueue('q', 'a', { dedupeKey: 'a' });
    await queue.enqueue('q', 'b');

    await expect(queue.enqueue('q', 'c')).rejects.toThrow('FLOWFN_QUEUE_FULL');
    // A deduplicated enqueue adds nothing, so it is not rejected as full.
    await expect(queue.enqueue('q', 'a', { dedupeKey: 'a' })).resolves.toMatchObject({ deduplicated: true });
    await expect(queue.enqueue('other', 'c')).resolves.toMatchObject({ deduplicated: false });

    const job = await queue.claim('q', { leaseMs: 1_000 });
    await expect(queue.enqueue('q', 'c')).rejects.toThrow('FLOWFN_QUEUE_FULL');
    await queue.ack(job!.id);
    await expect(queue.enqueue('q', 'c')).resolves.toMatchObject({ deduplicated: false });
  });

  it('rejects an invalid maxSize', () => {
    expect(() => new MemoryQueueAdapter<string>({ maxSize: 0 })).toThrow('FLOWFN_QUEUE_MAX_SIZE_INVALID');
    expect(() => new MemoryQueueAdapter<string>({ maxSize: -1 })).toThrow('FLOWFN_QUEUE_MAX_SIZE_INVALID');
    expect(() => new MemoryQueueAdapter<string>({ maxSize: 1.5 })).toThrow('FLOWFN_QUEUE_MAX_SIZE_INVALID');
  });

  it('keeps payloads by reference, including undefined', async () => {
    const queue = new MemoryQueueAdapter<{ n: number } | undefined>();
    const payload = { n: 1 };
    await queue.enqueue('q', payload);
    await queue.enqueue('q', undefined);
    expect((await queue.claim('q', { leaseMs: 1_000 }))?.payload).toBe(payload);
    const second = await queue.claim('q', { leaseMs: 1_000 });
    expect(second).toMatchObject({ attempt: 1 });
    expect(second?.payload).toBeUndefined();
  });

  it('throws QueueError with a machine-readable code', async () => {
    const queue = new MemoryQueueAdapter<string>();
    const error = await queue.claim('', { leaseMs: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueueError);
    expect(error).toMatchObject({ code: 'FLOWFN_QUEUE_NAME_INVALID' });
  });

  it('hands every job to exactly one of several interleaved claimers', async () => {
    const queue = new MemoryQueueAdapter<number>();
    for (let n = 0; n < 100; n += 1) {
      await queue.enqueue('q', n);
    }
    const acked = (await drainConcurrently(Array.from({ length: 8 }, () => queue), 'q')).flat();
    expect(acked).toHaveLength(100);
    expect(new Set(acked).size).toBe(100);
  });
});
