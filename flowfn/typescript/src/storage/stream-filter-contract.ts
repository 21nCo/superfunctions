import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { FlowAdapter } from '../adapters/base.js';
import { StreamImpl } from '../stream/stream.js';

export async function streamFilterContract(adapter: FlowAdapter) {
  const stream = new StreamImpl<number>(randomUUID(), adapter);
  const broadcast: number[] = [], grouped: number[] = [];
  let retry = true;
  try {
    await stream.subscribe(async message => { broadcast.push(message.data); }, { filter: async message => message.data % 2 === 0 });
    const consumer = stream.createConsumer('filtered', { groupId: 'group', autoCommit: false, filter: async message => {
      if (message.data === 3 && retry) { retry = false; throw new Error('temporary predicate failure'); }
      return message.data % 2 === 1;
    } });
    await consumer.subscribe(async message => { grouped.push(message.data); await message.ack(); });
    await stream.publishBatch([1, 2, 3, 4].map(data => ({ data })));
    await vi.waitFor(() => expect(broadcast).toEqual([2, 4]), { timeout: 5000 });
    await vi.waitFor(() => expect(grouped).toEqual([1, 3]), { timeout: 5000 });
    await vi.waitFor(async () => expect((await stream.getInfo()).lag).toBe(0), { timeout: 5000 });
    expect((await stream.getMessages('-', '+')).map(message => message.data)).toEqual([1, 2, 3, 4]);
  } finally { await stream.close(); }
}
