import { afterEach, describe, expect, it } from 'vitest';
import type { QueueAdapter } from '../index.js';

export interface ContractTarget {
  queue: QueueAdapter<unknown>;
  cleanup?: () => Promise<void>;
}

/** Creates a fresh, empty queue that reads time from `now`. */
export type ContractFactory = (now: () => number) => Promise<ContractTarget>;

const START = Date.UTC(2026, 9, 26);

/**
 * Behaviour every `QueueAdapter` must share. Each backend runs the same
 * cases against a controllable clock.
 */
export function describeQueueContract(name: string, factory: ContractFactory): void {
  describe(`${name} queue contract`, () => {
    let time = START;
    let cleanup: (() => Promise<void>) | undefined;

    const setup = async () => {
      time = START;
      const target = await factory(() => time);
      cleanup = target.cleanup;
      return target.queue;
    };
    const advance = (ms: number) => {
      time += ms;
    };

    afterEach(async () => {
      await cleanup?.();
      cleanup = undefined;
    });

    it('enqueues, claims in FIFO order and acks', async () => {
      const queue = await setup();
      const first = await queue.enqueue('jobs', { n: 1 });
      const second = await queue.enqueue('jobs', { n: 2 });
      expect(first).toEqual({ id: expect.any(String), deduplicated: false });
      expect(second.id).not.toBe(first.id);
      expect(await queue.size('jobs')).toBe(2);

      const claimed = await queue.claim('jobs', { leaseMs: 1_000 });
      expect(claimed).toEqual({ id: first.id, payload: { n: 1 }, attempt: 1 });
      // A leased job still counts until it is acked.
      expect(await queue.size('jobs')).toBe(2);

      const next = await queue.claim('jobs', { leaseMs: 1_000 });
      expect(next).toEqual({ id: second.id, payload: { n: 2 }, attempt: 1 });
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();

      await queue.ack(first.id);
      await queue.ack(second.id, { attempt: 1 });
      expect(await queue.size('jobs')).toBe(0);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      await expect(queue.ack(first.id)).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
    });

    it('round-trips JSON payloads', async () => {
      const queue = await setup();
      const payload = { text: 'héllo ☃ "quoted"', nested: { list: [1, 2.5, null, true] }, empty: '' };
      await queue.enqueue('jobs', payload);
      await queue.enqueue('jobs', null);
      expect((await queue.claim('jobs', { leaseMs: 1_000 }))?.payload).toEqual(payload);
      expect((await queue.claim('jobs', { leaseMs: 1_000 }))?.payload).toBeNull();
    });

    it('keeps queues independent', async () => {
      const queue = await setup();
      await queue.enqueue('a', 'from-a');
      await queue.enqueue(' b ', 'from-b');
      expect(await queue.size('b')).toBe(1);
      expect((await queue.claim('b', { leaseMs: 1_000 }))?.payload).toBe('from-b');
      expect(await queue.claim('b', { leaseMs: 1_000 })).toBeNull();
      expect((await queue.claim('a', { leaseMs: 1_000 }))?.payload).toBe('from-a');
    });

    it('peeks pending and leased jobs in claim order without claiming them', async () => {
      const queue = await setup();
      const first = await queue.enqueue('jobs', 'first');
      const delayed = await queue.enqueue('jobs', 'delayed', { delayMs: 5_000 });
      const third = await queue.enqueue('jobs', 'third', { dedupeKey: 'k' });
      await queue.claim('jobs', { leaseMs: 1_000 });

      const jobs = await queue.peek('jobs', 10);
      expect(jobs.map((job) => [job.id, job.state, job.attempt])).toEqual([
        [first.id, 'leased', 1],
        [third.id, 'pending', 0],
        [delayed.id, 'pending', 0],
      ]);
      expect(jobs[0]).toMatchObject({
        queue: 'jobs',
        payload: 'first',
        leaseUntil: new Date(START + 1_000),
        availableAt: new Date(START),
        dedupeKey: null,
        lastError: null,
        createdAt: new Date(START),
      });
      expect(jobs[1].dedupeKey).toBe('k');
      expect(jobs[2].availableAt).toEqual(new Date(START + 5_000));
      expect((await queue.peek('jobs', 1)).map((job) => job.id)).toEqual([first.id]);
      expect(await queue.peek('jobs', 0)).toEqual([]);
      expect((await queue.claim('jobs', { leaseMs: 1_000 }))?.id).toBe(third.id);
    });

    it('does not hand out a delayed job before its delay', async () => {
      const queue = await setup();
      const delayed = await queue.enqueue('jobs', 'later', { delayMs: 1_000 });
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      const immediate = await queue.enqueue('jobs', 'now');
      expect((await queue.claim('jobs', { leaseMs: 60_000 }))?.id).toBe(immediate.id);

      advance(999);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      advance(1);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toEqual({ id: delayed.id, payload: 'later', attempt: 1 });
    });

    it('retries a failed job at retryAt with the next attempt', async () => {
      const queue = await setup();
      const { id } = await queue.enqueue('jobs', 'flaky');
      await queue.claim('jobs', { leaseMs: 1_000 });
      await queue.fail(id, { retryAt: new Date(START + 500), reason: 'timeout', attempt: 1 });

      const [pending] = await queue.peek('jobs', 1);
      expect(pending).toMatchObject({ id, state: 'pending', leaseUntil: null, lastError: 'timeout' });
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      advance(500);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toEqual({ id, payload: 'flaky', attempt: 2 });

      await queue.fail(id, { retryAt: START + 500 });
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toMatchObject({ id, attempt: 3 });
    });

    it('dead-letters a failed job so it is never claimed again', async () => {
      const queue = await setup();
      const { id } = await queue.enqueue('jobs', 'poison', { dedupeKey: 'poison' });
      await queue.claim('jobs', { leaseMs: 1_000 });
      await queue.fail(id, { deadLetter: true, reason: 'bad payload' });

      expect(await queue.size('jobs')).toBe(0);
      expect(await queue.peek('jobs', 10)).toEqual([]);
      advance(60_000);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      await expect(queue.ack(id)).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      // A dead job no longer holds its dedupe key.
      const again = await queue.enqueue('jobs', 'poison', { dedupeKey: 'poison' });
      expect(again.deduplicated).toBe(false);
      expect(again.id).not.toBe(id);
    });

    it('treats a duplicate dedupeKey as a no-op while the job is pending or leased', async () => {
      const queue = await setup();
      const first = await queue.enqueue('jobs', 'one', { dedupeKey: 'k' });
      expect(await queue.enqueue('jobs', 'two', { dedupeKey: 'k', delayMs: 5_000 })).toEqual({
        id: first.id,
        deduplicated: true,
      });
      const other = await queue.enqueue('other', 'three', { dedupeKey: 'k' });
      expect(other.deduplicated).toBe(false);
      expect(await queue.size('jobs')).toBe(1);

      const claimed = await queue.claim('jobs', { leaseMs: 1_000 });
      expect(claimed?.payload).toBe('one');
      expect(await queue.enqueue('jobs', 'four', { dedupeKey: 'k' })).toEqual({ id: first.id, deduplicated: true });

      await queue.ack(first.id);
      const fresh = await queue.enqueue('jobs', 'five', { dedupeKey: 'k' });
      expect(fresh.deduplicated).toBe(false);
      expect(fresh.id).not.toBe(first.id);
      expect((await queue.claim('jobs', { leaseMs: 1_000 }))?.payload).toBe('five');
    });

    it('makes an expired lease claimable again with the next attempt and fences the stale claimer', async () => {
      const queue = await setup();
      const { id } = await queue.enqueue('jobs', 'slow');
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toMatchObject({ id, attempt: 1 });

      advance(999);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      advance(1);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toEqual({ id, payload: 'slow', attempt: 2 });

      await expect(queue.ack(id, { attempt: 1 })).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      await expect(queue.extendLease(id, 1_000, { attempt: 1 })).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      await expect(queue.fail(id, { deadLetter: true, reason: 'x', attempt: 1 })).rejects.toThrow(
        'FLOWFN_QUEUE_JOB_NOT_LEASED'
      );
      await queue.ack(id, { attempt: 2 });
      expect(await queue.size('jobs')).toBe(0);
    });

    it('extends a lease from the current time', async () => {
      const queue = await setup();
      const { id } = await queue.enqueue('jobs', 'long');
      await queue.claim('jobs', { leaseMs: 1_000 });
      advance(900);
      await queue.extendLease(id, 1_000, { attempt: 1 });
      advance(900);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toBeNull();
      advance(100);
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toMatchObject({ id, attempt: 2 });
    });

    it('rejects ack, fail and extendLease for jobs that are not leased', async () => {
      const queue = await setup();
      const { id } = await queue.enqueue('jobs', 'waiting');
      await expect(queue.ack(id)).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      await expect(queue.fail(id, { retryAt: START })).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      await expect(queue.extendLease(id, 1_000)).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      await expect(queue.ack('999999')).rejects.toThrow('FLOWFN_QUEUE_JOB_NOT_LEASED');
      expect(await queue.claim('jobs', { leaseMs: 1_000 })).toMatchObject({ id, attempt: 1 });
    });

    it('rejects malformed input before touching storage', async () => {
      const queue = await setup();
      await expect(queue.enqueue('../jobs', 'x')).rejects.toThrow('FLOWFN_QUEUE_NAME_INVALID');
      await expect(queue.enqueue('  ', 'x')).rejects.toThrow('FLOWFN_QUEUE_NAME_INVALID');
      await expect(queue.enqueue('jobs', 'x', { delayMs: -1 })).rejects.toThrow('FLOWFN_QUEUE_DELAY_INVALID');
      await expect(queue.enqueue('jobs', 'x', { delayMs: 1.5 })).rejects.toThrow('FLOWFN_QUEUE_DELAY_INVALID');
      await expect(queue.enqueue('jobs', 'x', { dedupeKey: '' })).rejects.toThrow('FLOWFN_QUEUE_DEDUPE_KEY_INVALID');
      await expect(queue.enqueue('jobs', 'x', { delayMs: 1e15 })).rejects.toThrow('FLOWFN_QUEUE_DELAY_INVALID');
      await expect(queue.claim('jobs', { leaseMs: 0 })).rejects.toThrow('FLOWFN_QUEUE_LEASE_INVALID');
      await expect(queue.claim('jobs', { leaseMs: 1e15 })).rejects.toThrow('FLOWFN_QUEUE_LEASE_INVALID');
      await expect(queue.claim('jobs', {} as { leaseMs: number })).rejects.toThrow('FLOWFN_QUEUE_LEASE_INVALID');
      await expect(queue.peek('jobs', -1)).rejects.toThrow('FLOWFN_QUEUE_LIMIT_INVALID');
      await expect(queue.size('a/b')).rejects.toThrow('FLOWFN_QUEUE_NAME_INVALID');
      await expect(queue.ack('abc')).rejects.toThrow('FLOWFN_QUEUE_JOB_ID_INVALID');
      await expect(queue.ack('1', { attempt: 0 })).rejects.toThrow('FLOWFN_QUEUE_ATTEMPT_INVALID');
      await expect(queue.extendLease('1', Number.NaN)).rejects.toThrow('FLOWFN_QUEUE_LEASE_INVALID');
      await expect(queue.fail('1', { retryAt: Number.NaN })).rejects.toThrow('FLOWFN_QUEUE_RETRY_AT_INVALID');
      await expect(queue.fail('1', { deadLetter: true, reason: '' })).rejects.toThrow(
        'FLOWFN_QUEUE_FAIL_OPTIONS_INVALID'
      );
      await expect(queue.fail('1', {} as { retryAt: number })).rejects.toThrow('FLOWFN_QUEUE_FAIL_OPTIONS_INVALID');
      expect(await queue.size('jobs')).toBe(0);
    });
  });
}

/**
 * Runs `claimers` concurrent claim/ack loops and returns every acked id per
 * claimer. Each claimer stops once the queue reports nothing claimable.
 */
export async function drainConcurrently(
  queues: QueueAdapter<unknown>[],
  queueName: string
): Promise<string[][]> {
  return Promise.all(
    queues.map(async (queue) => {
      const acked: string[] = [];
      for (;;) {
        const job = await queue.claim(queueName, { leaseMs: 60_000 });
        if (!job) {
          return acked;
        }
        await queue.ack(job.id, { attempt: job.attempt });
        acked.push(job.id);
      }
    })
  );
}
