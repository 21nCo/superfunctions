import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { FlowAdapter } from '../adapters/base.js';
import { StreamImpl } from '../stream/stream.js';
import type { Message } from '../stream/types.js';

export async function streamRenewalContract(adapter: FlowAdapter) {
  const stream = new StreamImpl<number>(randomUUID(), adapter);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first: Message<number>[] = [], other: Message<number>[] = [];
  const options = { groupId: 'group', visibilityTimeout: 1000 };
  const a = stream.createConsumer('a', options), b = stream.createConsumer('b', options);
  try {
    await a.subscribe(async message => { first.push(message); await gate; });
    await stream.publish(1);
    await vi.waitFor(() => expect(first).toHaveLength(1));
    await b.subscribe(async message => { other.push(message); });
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(other).toHaveLength(0);
    expect(first[0].signal?.aborted).toBe(false);
    release();
    await vi.waitFor(async () => expect((await stream.getInfo()).lag).toBe(0));
  } finally { release(); await stream.close(); }
}

export async function streamLossContract(adapter: FlowAdapter, expire: (stream: string, id: string) => Promise<unknown>) {
  const stream = new StreamImpl<number>(randomUUID(), adapter);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first: Message<number>[] = [], replacement: Message<number>[] = [];
  const options = { groupId: 'group', visibilityTimeout: 1000, autoCommit: false };
  const a = stream.createConsumer('a', options), b = stream.createConsumer('b', options);
  try {
    await a.subscribe(async message => { first.push(message); await gate; await message.ack(); });
    await stream.publish(1);
    await vi.waitFor(() => expect(first).toHaveLength(1));
    await expire(stream.name, first[0].id);
    await vi.waitFor(() => expect(first[0].signal?.aborted).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(first).toHaveLength(1);
    await b.subscribe(async message => { replacement.push(message); });
    await vi.waitFor(() => expect(replacement).toHaveLength(1));
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await stream.getInfo()).lag).toBe(1);
    await replacement[0].ack();
    expect((await stream.getInfo()).lag).toBe(0);
  } finally { release(); await stream.close(); }
}

export async function streamUnsubscribeContract(adapter: FlowAdapter) {
  const stream = new StreamImpl<number>(randomUUID(), adapter);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first: Message<number>[] = [], replacement: Message<number>[] = [];
  const options = { groupId: 'group', visibilityTimeout: 1000, autoCommit: false };
  const a = stream.createConsumer('a', options), b = stream.createConsumer('b', options);
  try {
    await a.subscribe(async message => { first.push(message); await gate; await message.ack(); });
    await stream.publish(1);
    await vi.waitFor(() => expect(first).toHaveLength(1));
    await a.close();
    expect(first[0].signal?.aborted).toBe(true);
    await b.subscribe(async message => { replacement.push(message); });
    await vi.waitFor(() => expect(replacement).toHaveLength(1));
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await stream.getInfo()).lag).toBe(1);
    await replacement[0].ack();
    expect((await stream.getInfo()).lag).toBe(0);
  } finally { release(); await stream.close(); }
}

/** A returned callback still occupies capacity only until its confirmed receipt expires. */
export async function streamManualExpiryContract(adapter: FlowAdapter, partitions?: number) {
  const stream = new StreamImpl<number>(randomUUID(), adapter, partitions === undefined ? {} : { partitions });
  const seen: Message<number>[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const consumer = stream.createConsumer('single', { groupId: 'group', fromBeginning: true, autoCommit: false, maxInFlight: 1, visibilityTimeout: 300 });
  try {
    const id = await stream.publish(1);
    await consumer.subscribe(async message => {
      seen.push(message);
      if (seen.length > 1) await held;
    });
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 2000 });
    expect(seen.map(message => message.id)).toEqual([id, id]);
    expect(seen[0].signal?.aborted).toBe(true);
    expect(seen[1].signal?.aborted).toBe(false);
    await seen[0].ack();
    await seen[0].nack(true);
    expect((await stream.getInfo()).lag).toBe(1);
    await seen[1].ack();
    expect((await stream.getInfo()).lag).toBe(0);
  } finally { release(); await stream.close(); }
}
