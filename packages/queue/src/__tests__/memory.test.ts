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

  it('keeps capacity and dedupe keys per queue through retry, dead-letter and ack', async () => {
    const queue = new MemoryQueueAdapter<string>({ maxSize: 2 });
    const first = await queue.enqueue('q', 'a', { dedupeKey: 'a' });
    await queue.enqueue('q', 'b', { dedupeKey: 'b' });
    await queue.enqueue('other', 'a', { dedupeKey: 'a' });
    await queue.enqueue('other', 'b');

    // A retried job keeps its slot and its dedupe key.
    const leased = await queue.claim('q', { leaseMs: 1_000 });
    expect(leased?.id).toBe(first.id);
    await queue.fail(first.id, { retryAt: new Date(0) });
    await expect(queue.enqueue('q', 'c')).rejects.toThrow('FLOWFN_QUEUE_FULL');
    expect(await queue.enqueue('q', 'a', { dedupeKey: 'a' })).toEqual({ id: first.id, deduplicated: true });

    // Dead-lettering frees both; the other queue's job with the same key is untouched.
    await queue.claim('q', { leaseMs: 1_000 });
    await queue.fail(first.id, { deadLetter: true, reason: 'poison' });
    expect(await queue.size('q')).toBe(1);
    expect(await queue.enqueue('other', 'a', { dedupeKey: 'a' })).toMatchObject({ deduplicated: true });
    const replacement = await queue.enqueue('q', 'a', { dedupeKey: 'a' });
    expect(replacement).toMatchObject({ deduplicated: false });
    expect(replacement.id).not.toBe(first.id);

    // Draining a queue completely and refilling it starts from an empty index.
    for (let job = await queue.claim('q', { leaseMs: 1_000 }); job; job = await queue.claim('q', { leaseMs: 1_000 })) {
      await queue.ack(job.id);
    }
    expect(await queue.size('q')).toBe(0);
    expect(await queue.peek('q', 10)).toEqual([]);
    expect(await queue.enqueue('q', 'b', { dedupeKey: 'b' })).toMatchObject({ deduplicated: false });
    expect(await queue.size('other')).toBe(2);
  });

  it('enqueues in constant time regardless of retained backlog', async () => {
    const queue = new MemoryQueueAdapter<number>({ maxSize: 100_000 });
    const started = performance.now();
    for (let n = 0; n < 20_000; n += 1) {
      await queue.enqueue('backlog', n);
    }
    for (let n = 0; n < 20_000; n += 1) {
      await queue.enqueue('other', n, { dedupeKey: `k${n % 10_000}` });
    }
    // A per-enqueue scan of retained jobs makes this quadratic (several seconds);
    // indexed enqueue takes milliseconds.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await queue.size('backlog')).toBe(20_000);
    expect(await queue.size('other')).toBe(10_000);
  }, 60_000);

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
