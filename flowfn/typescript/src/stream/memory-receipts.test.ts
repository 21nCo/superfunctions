import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { StreamImpl } from './stream.js';
import type { Message } from './types.js';
let adapter: MemoryAdapter;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); adapter = new MemoryAdapter(); });
afterEach(async () => { await adapter.cleanup(); vi.useRealTimers(); });

it.each([undefined, 2])('expires returned manual receipts and fences stale settlement (%s partitions)', async partitions => {
  const stream = new StreamImpl<number>('manual', adapter, partitions === undefined ? {} : { partitions });
  const id = await stream.publish(1);
  const seen: Message<number>[] = [];
  const consumer = stream.createConsumer('single', { groupId: 'g', fromBeginning: true, autoCommit: false, maxInFlight: 1, visibilityTimeout: 90 });
  try {
    await consumer.subscribe(async message => { seen.push(message); });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(89);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.map(message => message.id)).toEqual([id, id]);
    expect(seen[0].signal?.aborted).toBe(true);
    expect(seen[1].signal?.aborted).toBe(false);
    await seen[0].ack(); await seen[0].nack(true);
    expect((await stream.getInfo()).lag).toBe(1);
    await seen[1].ack();
    expect((await stream.getInfo()).lag).toBe(0);
  } finally { await stream.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, 2])('aborts returned pending receipt signals on unsubscribe and cleanup (%s partitions)', async partitions => {
  for (const cleanup of [false, true]) {
    const stream = new StreamImpl<number>(`close-${cleanup}`, adapter, partitions === undefined ? {} : { partitions });
    await stream.publish(1);
    const seen: Message[] = [];
    const consumer = stream.createConsumer('single', { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
    await consumer.subscribe(async message => { seen.push(message); });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].signal?.aborted).toBe(false);
    if (cleanup) await adapter.cleanup(); else await consumer.close();
    expect(seen[0].signal?.aborted).toBe(true);
    await seen[0].ack();
    expect(vi.getTimerCount()).toBe(0);
    await stream.close();
  }
});

it('renews a legacy active callback, then expires it after return without overlapping its valid receipt', async () => {
  const stream = new StreamImpl<number>('active', adapter);
  const id = await stream.publish(1);
  const first: Message[] = [], recovered: Message[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = stream.createConsumer('owner', { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  const follower = stream.createConsumer('follower', { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  try {
    await owner.subscribe(async message => { first.push(message); await gate; });
    await follower.subscribe(async message => { recovered.push(message); });
    await vi.advanceTimersByTimeAsync(270);
    expect(first.map(message => message.id)).toEqual([id]);
    expect(recovered).toHaveLength(0);
    expect(first[0].signal?.aborted).toBe(false);
    await owner.pause(); release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(89);
    expect(recovered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first[0].signal?.aborted).toBe(true);
    expect(recovered.map(message => message.id)).toEqual([id]);
    await recovered[0].ack();
  } finally { release(); await stream.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('does not resurrect trimmed legacy payload when its manual receipt expires', async () => {
  const stream = new StreamImpl<number>('trimmed-manual', adapter);
  await stream.publish(1);
  const seen: Message[] = [];
  const consumer = stream.createConsumer('single', { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  try {
    await consumer.subscribe(async message => { seen.push(message); });
    await vi.advanceTimersByTimeAsync(0);
    expect(await stream.trim({ maxLength: 0 })).toBe(1);
    await vi.advanceTimersByTimeAsync(90);
    expect(seen).toHaveLength(1);
    expect(seen[0].signal?.aborted).toBe(true);
    expect(await stream.getInfo()).toMatchObject({ length: 0, lag: 0 });
    await stream.publish(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map(message => message.data)).toEqual([1, 2]);
    await seen[0].ack();
    expect((await stream.getInfo()).lag).toBe(1);
    await seen[1].ack();
  } finally { await stream.close(); }
  expect(vi.getTimerCount()).toBe(0);
});
