/** Copied into the isolated tarball consumer; imports only installed packages. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFlow } from '@flowfn/core';
import { RedisAdapter } from '@flowfn/core/adapters/redis';
import Redis from 'ioredis';

const url = new URL(process.env.FLOWFN_REDIS_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Acceptance requires owned loopback Redis');
const prefix = `flowfn-packed-${randomUUID()}:`;
const control = new Redis(url.href);
const adapters = [0, 1].map(() => new RedisAdapter({ connection: new Redis(url.href), prefix }));
const flows = adapters.map(adapter => createFlow({ adapter }));
let release;
const gate = new Promise(resolve => { release = resolve; });
async function until(check, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Installed partition acceptance timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  const stream = flows[0].stream('installed', { partitions: 3 });
  const reopened = flows[1].stream('installed');
  const first = await stream.publish({ value: 1 }, { key: 'tenant-α' });
  const held = [], seen = [];
  const owner = stream.createConsumer('owner', { groupId: 'group', fromBeginning: true, autoCommit: false, visibilityTimeout: 1000 });
  await owner.subscribe(async message => { held.push(message); await gate; });
  await until(() => held.length === 1);
  assert.equal(held[0].id, first);
  assert.equal(held[0].partition, 2);
  assert.equal(await stream.trim({ maxLength: 0 }), 1);
  assert.deepEqual(await stream.getMessages('-', '+'), []);
  const later = await reopened.publish({ value: 2 }, { key: 'tenant-α' });
  const other = await reopened.publish({ value: 3 }, { partition: 0 });
  const follower = reopened.createConsumer('follower', { groupId: 'group', fromBeginning: true, maxInFlight: 2, visibilityTimeout: 1000 });
  await follower.subscribe(async message => { seen.push(message); await message.ack(); });
  await until(() => seen.some(message => message.id === other));
  assert.ok(!seen.some(message => message.id === later), 'Trim must not release a live partition');
  await until(() => seen.some(message => message.id === later));
  assert.equal(held[0].signal.aborted, true);
  assert.equal(seen.find(message => message.id === later).partition, 2);
  await held[0].ack();
  release();
  await owner.close();
  await follower.close();
  assert.equal((await reopened.getInfo()).partitions, 3);
  assert.deepEqual((await reopened.getMessages('-', '+')).map(message => message.id), [later, other]);
  assert.throws(() => flows[1].stream('installed', { partitions: 4 }), /partition/);
  await assert.rejects(adapters[1].configureStream('installed', 4), /immutable/);
  for (const partitions of [undefined, 2]) {
    const manual = flows[0].stream(`manual-${partitions ?? 'legacy'}`, partitions === undefined ? {} : { partitions });
    const id = await manual.publish(1);
    const receipts = [];
    const consumer = manual.createConsumer('single', { groupId: 'manual', fromBeginning: true, autoCommit: false, maxInFlight: 1, visibilityTimeout: 300 });
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    try {
      await consumer.subscribe(async message => { receipts.push(message); if (receipts.length > 1) await pending; });
      await until(() => receipts.length === 2);
      assert.deepEqual(receipts.map(message => message.id), [id, id]);
      assert.equal(receipts[0].signal.aborted, true);
      assert.equal(receipts[1].signal.aborted, false);
      await receipts[0].ack();
      await receipts[0].nack(true);
      assert.equal((await manual.getInfo()).lag, 1);
      await receipts[1].ack();
      assert.equal((await manual.getInfo()).lag, 0);
    } finally { settle(); await consumer.close(); }
  }
  console.log(JSON.stringify({ installedRedisPartitions: 'passed', routing: 'sha256-utf8-u32be-v1', retentionBarrier: 'passed', manualExpiry: 'passed', independentConnections: true }));
} finally {
  release();
  const closed = await Promise.allSettled(flows.map(flow => flow.close({ timeout: 5000 })));
  try {
    const keys = await control.keys(`${prefix}*`);
    if (keys.length) await control.del(...keys);
    assert.deepEqual(await control.keys(`${prefix}*`), []);
  } finally { await control.quit(); }
  const failure = closed.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
