import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '../adapters/memory.js';
import { StreamImpl } from './stream.js';
import type { Message } from './types.js';
let adapter: MemoryAdapter;
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); adapter = new MemoryAdapter(); });
afterEach(async () => { await adapter.cleanup(); vi.useRealTimers(); });

it('routes keys with the persisted-in-instance immutable policy and preserves global history', async () => {
  const stream = new StreamImpl<number>('events', adapter, { partitions: 3 });
  const first = await stream.publish(1, { key: 'tenantα' });
  const reopened = new StreamImpl<number>('events', adapter);
  const second = await reopened.publish(2, { key: 'tenantα' });
  expect((await reopened.getMessages('-', '+')).map(m => [m.id, m.partition])).toEqual([[first, 2], [second, 2]]);
  expect(await reopened.getInfo()).toMatchObject({ partitions: 3, length: 2 });
  await expect(new StreamImpl('events', adapter, { partitions: 2 }).publish(3)).rejects.toThrow('immutable');
  await expect(stream.publish(4, { partition: 3 })).rejects.toThrow('range');
  await stream.close(); await reopened.close();
});

it('blocks a held partition across retention while other partitions progress', async () => {
  const stream = new StreamImpl<number>('events', adapter, { partitions: 2 });
  const first = await stream.publish(1, { partition: 0 });
  const held: Message[] = [], seen: Message[] = [];
  const owner = await adapter.consume('events', 'group', 'owner', async m => { held.push(m); }, { groupId: 'group', fromBeginning: true, autoCommit: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(held.map(m => m.id)).toEqual([first]);
  await stream.trim({ maxLength: 0 });
  const later = await stream.publish(2, { partition: 0 });
  const other = await stream.publish(3, { partition: 1 });
  const follower = await adapter.consume('events', 'group', 'follower', async m => { seen.push(m); }, { groupId: 'group', fromBeginning: true, autoCommit: false, maxInFlight: 3 });
  await vi.advanceTimersByTimeAsync(40);
  expect(seen.map(m => m.id)).toEqual([other]);
  await owner.pause?.();
  await held[0].ack();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.map(m => m.id)).toEqual([other, later]);
  await held[0].nack();
  expect(await stream.getInfo()).toMatchObject({ length: 2 });
  await owner.unsubscribe(); await follower.unsubscribe(); await stream.close();
});

it('renews held callbacks, expires unacknowledged receipts, and fences their stale acknowledgment', async () => {
  const stream = new StreamImpl('leases', adapter, { partitions: 1 });
  const first = await stream.publish(1);
  const later = await stream.publish(2);
  const held: Message[] = [], recovered: Message[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = await adapter.consume('leases', 'g', 'owner', async m => { held.push(m); await gate; }, { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  const follower = await adapter.consume('leases', 'g', 'follower', async m => { recovered.push(m); }, { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  try {
    await vi.advanceTimersByTimeAsync(270);
    expect(held.map(m => m.id)).toEqual([first]);
    expect(recovered).toHaveLength(0);
    expect(held[0].signal?.aborted).toBe(false);
    await owner.pause?.();
    release(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(89);
    expect(recovered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(held[0].signal?.aborted).toBe(true);
    expect(recovered.map(m => m.id)).toEqual([first]);
    await held[0].ack();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered).toHaveLength(1);
    await recovered[0].ack(); await vi.advanceTimersByTimeAsync(0);
    expect(recovered.map(m => m.id)).toEqual([first, later]);
  } finally { release(); await owner.unsubscribe(); await follower.unsubscribe(); await stream.close(); }
});

it('does not renew a trimmed receipt and retains its barrier until original expiry', async () => {
  const stream = new StreamImpl('trim-lease', adapter, { partitions: 1 });
  await stream.publish(1);
  const held: Message[] = [], seen: Message[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = await adapter.consume('trim-lease', 'g', 'owner', async m => { held.push(m); await gate; }, { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  await vi.advanceTimersByTimeAsync(0);
  await stream.trim({ maxLength: 0 });
  const next = await stream.publish(2);
  const follower = await adapter.consume('trim-lease', 'g', 'follower', async m => { seen.push(m); }, { groupId: 'g', fromBeginning: true, autoCommit: false, visibilityTimeout: 90 });
  try {
    await vi.advanceTimersByTimeAsync(89);
    expect(held[0].signal?.aborted).toBe(true);
    expect(seen).toHaveLength(0);
    expect(await stream.getInfo()).toMatchObject({ length: 1, lag: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.map(m => m.id)).toEqual([next]);
    await held[0].ack();
    expect(await stream.getInfo()).toMatchObject({ lag: 1 });
  } finally { release(); await owner.unsubscribe(); await follower.unsubscribe(); await stream.close(); }
});

it('locks legacy policy even after all historical payloads are removed', async () => {
  const legacy = new StreamImpl('legacy', adapter);
  await legacy.publish(1); await legacy.trim({ maxLength: 0 });
  await expect(new StreamImpl('legacy', adapter, { partitions: 1 }).publish(2)).rejects.toThrow('immutable');
  await expect(legacy.publish(2, { partition: 0 })).rejects.toThrow('configured');
  await legacy.close();
});

it('preserves separate group cutoffs and partition cursors when consumers reopen', async () => {
  const stream = new StreamImpl<number>('progress', adapter, { partitions: 2 });
  await stream.publish(0, { partition: 0 });
  const seen: number[] = [], all: number[] = [];
  let first = await adapter.consume('progress', 'tail', 'one', async m => { seen.push(m.data); await m.ack(); }, { groupId: 'tail', maxInFlight: 2 });
  const other = await adapter.consume('progress', 'all', 'one', async m => { all.push(m.data); await m.ack(); }, { groupId: 'all', fromBeginning: true, maxInFlight: 2 });
  await stream.publish(1, { partition: 1 }); await stream.publish(2, { partition: 0 });
  await vi.advanceTimersByTimeAsync(0);
  await first.unsubscribe();
  first = await adapter.consume('progress', 'tail', 'two', async m => { seen.push(m.data); await m.ack(); }, { groupId: 'tail', fromBeginning: true, maxInFlight: 2 });
  await stream.publish(3, { partition: 1 }); await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([1, 2, 3]); expect(all).toEqual([0, 1, 2, 3]);
  expect(await stream.getInfo()).toMatchObject({ groups: 2, lag: 0 });
  const replay: number[] = [];
  expect(await stream.replay(0, async m => { replay.push(m.data); })).toBe(4);
  expect(replay).toEqual([0, 1, 2, 3]);
  await first.unsubscribe(); await other.unsubscribe(); await stream.close();
});

it('retries before the same-partition successor and fences unsubscribed owners', async () => {
  const stream = new StreamImpl('retry', adapter, { partitions: 1 });
  const first = await stream.publish(1), later = await stream.publish(2);
  const old: Message[] = [], next: Message[] = [];
  const owner = await adapter.consume('retry', 'g', 'old', async m => { old.push(m); }, { groupId: 'g', fromBeginning: true, autoCommit: false });
  await vi.advanceTimersByTimeAsync(0);
  await owner.unsubscribe();
  const follower = await adapter.consume('retry', 'g', 'next', async m => { next.push(m); }, { groupId: 'g', fromBeginning: true, autoCommit: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(next.map(m => m.id)).toEqual([first]);
  await old[0].ack(); await vi.advanceTimersByTimeAsync(0);
  expect(next).toHaveLength(1);
  await next[0].nack(); await vi.advanceTimersByTimeAsync(20);
  expect(next.map(m => m.id)).toEqual([first, first]);
  await next[0].ack(); await next[1].ack(); await vi.advanceTimersByTimeAsync(0);
  expect(next.map(m => m.id)).toEqual([first, first, later]);
  await follower.unsubscribe(); await stream.close();
  expect(vi.getTimerCount()).toBe(0);
});
