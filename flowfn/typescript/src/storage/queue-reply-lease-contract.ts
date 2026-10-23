import { expect, vi } from 'vitest';
import type { FlowAdapter } from '../adapters/base.js';
import { QueueImpl } from '../queue/queue.js';

export async function queueReplyLeaseContract(adapter: FlowAdapter) {
  const timings: Array<{ method: string; elapsed: number }> = [];
  const dequeue = adapter.dequeue.bind(adapter);
  const renew = adapter.renewJobLease!.bind(adapter);
  vi.spyOn(adapter, 'dequeue').mockImplementation(async (...args) => {
    const started = performance.now();
    const result = await dequeue(...args);
    if (result) await new Promise(resolve => setTimeout(resolve, 450));
    timings.push({ method: 'claim', elapsed: performance.now() - started });
    return result;
  });
  let renewals = 0;
  vi.spyOn(adapter, 'renewJobLease').mockImplementation(async (...args) => {
    const started = performance.now();
    const result = await renew(...args);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (result) renewals++;
    timings.push({ method: 'renew', elapsed: performance.now() - started });
    return result;
  });
  const queue = new QueueImpl('reply-delay', adapter, { leaseDuration: 1000 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  let entered = false;
  try {
    const job = await queue.add('held', {});
    queue.process(async current => {
      signal = current.signal;
      entered = true;
      await held;
      return 'completed';
    });
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 3000 });
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(signal?.aborted, JSON.stringify(timings)).toBe(false);
    expect(renewals).toBeGreaterThanOrEqual(2);
    release();
    await queue.drain();
    expect((await queue.getJob(job.id))?.returnvalue).toBe('completed');
    expect((await queue.getJob(job.id))?.stalledCount ?? 0).toBe(0);
  } finally {
    release();
    await queue.close();
  }
}

export async function queueExpiredReplyContract(adapter: FlowAdapter) {
  const renew = adapter.renewJobLease!.bind(adapter);
  let releaseReply!: () => void;
  const reply = new Promise<void>(resolve => { releaseReply = resolve; });
  let requested = false, settled = false;
  vi.spyOn(adapter, 'renewJobLease').mockImplementation(async (...args) => {
    const result = await renew(...args);
    requested = true;
    await reply;
    settled = true;
    return result;
  });
  const queue = new QueueImpl('expired-reply', adapter, { leaseDuration: 1000 });
  let releaseWork!: () => void;
  const held = new Promise<void>(resolve => { releaseWork = resolve; });
  let signal: AbortSignal | undefined;
  try {
    const job = await queue.add('held', {});
    queue.process(async current => { signal = current.signal; await held; return 'stale'; });
    await vi.waitFor(() => expect(requested).toBe(true), { timeout: 2000 });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1500 });
    expect(settled).toBe(false);
    releaseReply();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(signal?.aborted).toBe(true);
    releaseWork();
    await queue.close();
    expect((await queue.getJob(job.id))?.state).not.toBe('completed');
    expect((await queue.getJob(job.id))?.returnvalue).not.toBe('stale');
  } finally {
    releaseReply();
    releaseWork();
    await queue.close();
  }
}

export async function queueReleasedReplyContract(adapter: FlowAdapter) {
  const renew = adapter.renewJobLease!.bind(adapter);
  let releaseReply!: () => void;
  const reply = new Promise<void>(resolve => { releaseReply = resolve; });
  let requested = false, settled = false;
  const renewal = vi.spyOn(adapter, 'renewJobLease').mockImplementation(async (...args) => {
    const result = await renew(...args);
    requested = true;
    await reply;
    settled = true;
    return result;
  });
  const queue = new QueueImpl('released-reply', adapter, { leaseDuration: 1000 });
  let releaseWork!: () => void;
  const held = new Promise<void>(resolve => { releaseWork = resolve; });
  try {
    const job = await queue.add('held', {});
    queue.process(async () => { await held; return 'completed'; });
    await vi.waitFor(() => expect(requested).toBe(true), { timeout: 2000 });
    releaseWork();
    await queue.drain();
    await queue.close();
    releaseReply();
    await vi.waitFor(() => expect(settled).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(renewal).toHaveBeenCalledTimes(1);
    expect((await queue.getJob(job.id))?.returnvalue).toBe('completed');
  } finally {
    releaseReply();
    releaseWork();
    await queue.close();
  }
}
