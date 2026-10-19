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
