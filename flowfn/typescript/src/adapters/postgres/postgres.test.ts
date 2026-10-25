import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { queueReplyLeaseContract, queueExpiredReplyContract, queueReleasedReplyContract } from '../../storage/queue-reply-lease-contract.js';
import { queueClockContract } from '../../storage/queue-clock-contract.js';
import { workflowCancelContract } from '../../storage/workflow-cancel-contract.js';
import { streamFilterContract } from '../../storage/stream-filter-contract.js';
import { streamRenewalContract, streamLossContract, streamUnsubscribeContract } from '../../storage/stream-lease-contract.js';
import { shutdownContract } from '../../storage/shutdown-contract.js';
import { telemetryContract } from '../../storage/telemetry-contract.js';
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { getPostgresSchema } from "./schema.js";
import { PostgresAdapter } from "./index.js";
import { JobImpl } from "../../queue/job.js";
import { QueueImpl } from "../../queue/queue.js";
import { StreamImpl } from "../../stream/stream.js";
import type { Message } from "../../stream/types.js";
import { WorkflowBuilderImpl } from "../../workflow/workflow.js";
import { workflowControlContract } from '../../storage/workflow-control-contract.js';
import { workflowCrashContract } from '../../storage/workflow-crash-contract.js';
import { schedulerContract } from '../../storage/scheduler-contract.js';
import { workerOwnershipContract, workerPoolContract } from '../../storage/worker-contract.js';

describe.skipIf(!process.env.FLOWFN_POSTGRES_URL)(
  "PostgreSQL native contract (requires FLOWFN_POSTGRES_URL)",
  () => {
    let pool: Pool, adapter: PostgresAdapter, schema: string;
    it.each([false, true])('delivers remote workflow cancellation across process ownership (restart=%s)', async restart => { await workflowCancelContract(adapter, 'postgres', schema, restart); });
    it('filters subscribers and group deliveries without losing history or retrying skipped messages', async () => { await streamFilterContract(adapter); });
    it('aborts active stream handlers on unsubscribe and requeues their receipt', async () => { await streamUnsubscribeContract(adapter); });
    it('renews active stream handlers across delivery expiry', async () => { await streamRenewalContract(adapter); });
    it('aborts stream handlers after delivery ownership expires and fences late acknowledgment', async () => { await streamLossContract(adapter, (stream, id) => pool.query(`UPDATE "${schema}".flowfn_deliveries SET delivered_at=0 WHERE stream=$1 AND message_id=$2`, [stream, id])); });
    it('bounds global shutdown and fences late callback results', async () => { await shutdownContract(adapter); });
    it('exports native operation spans and reports callback failures', async () => { await telemetryContract(adapter); });
    it('bounds worker shutdown and fences abandoned callbacks', async () => { await workerOwnershipContract(adapter, 1000); });
    it('scales independent worker groups without closing shared queues', async () => { await workerPoolContract(adapter); });
    it('recovers a schedule occurrence after SIGKILL with a stable idempotency identity', async () => { await workflowCrashContract(adapter, 'postgres', schema, true); });
    it('shares durable schedule ownership and preserves attempts across restart', async () => { await schedulerContract(adapter, 1000); });
    it('recovers a SIGKILL checkpoint in a new process without repeating effects', async () => { await workflowCrashContract(adapter, 'postgres', schema); });
    it('enforces durable workflow ownership and concurrent catalogs', async () => { await workflowControlContract(adapter, 1000); });
    it.each([-3_600_000, 3_600_000])('uses storage queue clocks under client skew %s', async skew => {
      await queueClockContract(adapter, skew, false);
      await queueClockContract(adapter, skew, true);
    });
    beforeEach(async () => {
      pool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      schema = `flowfn_${randomUUID().replaceAll("-", "")}`;
      adapter = new PostgresAdapter({
        db: drizzle(pool),
        schema,
        pollInterval: 10,
      });
      await adapter.initialize();
    });
    afterEach(async () => {
      await adapter.cleanup();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    it('persists partition routing and keeps a held key ordered while another partition progresses', async () => {
      const stream = new StreamImpl<{ value: number }>('partitioned', adapter, { partitions: 3 });
      const firstId = await stream.publish({ value: 1 }, { key: 'tenant-α' });
      const secondId = await stream.publish({ value: 2 }, { key: 'tenant-α' });
      const history = await stream.getMessages('-', '+');
      expect(history.map(message => message.partition)).toEqual([2, 2]);
      const otherId = await stream.publish({ value: 3 }, { partition: 0 });
      const peerPool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      const peer = new PostgresAdapter({ schema, db: drizzle(peerPool), pollInterval: 10 });
      const reopened = new StreamImpl<{ value: number }>('partitioned', peer);
      const seen: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const first = stream.createConsumer('first', { groupId: 'partition-workers', fromBeginning: true, maxInFlight: 3 });
      const second = reopened.createConsumer('second', { groupId: 'partition-workers', fromBeginning: true, maxInFlight: 3 });
      const handler = async (message: import('../../stream/types.js').Message<{ value: number }>) => {
        seen.push(message.id);
        if (message.id === firstId) await gate;
        await message.ack();
      };
      try {
        await first.subscribe(handler); await second.subscribe(handler);
        await vi.waitFor(() => expect(seen).toContain(otherId));
        expect(seen).toContain(firstId);
        expect(seen).not.toContain(secondId);
        release();
        await vi.waitFor(() => expect(seen).toContain(secondId));
        const reopenedId = await reopened.publish({ value: 4 }, { key: 'tenant-α' });
        expect((await reopened.getMessages(reopenedId, reopenedId))[0].partition).toBe(2);
        const conflict = new StreamImpl('partitioned', peer, { partitions: 4 });
        await expect(conflict.publish({})).rejects.toThrow(/partition/i);
        await conflict.close();
      } finally { release(); await first.close(); await second.close(); await stream.close(); await reopened.close(); await peer.cleanup(); await peerPool.end(); }
    });
    it('atomically fixes partition policy and rejects legacy or invalid publications without writes', async () => {
      const peer = new PostgresAdapter({ schema, db: drizzle(pool) });
      try {
        const results = await Promise.allSettled([adapter.configureStream('policy', 3), peer.configureStream('policy', 4)]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        const count = await adapter.configureStream('policy');
        expect([3, 4]).toContain(count);
        const stream = new StreamImpl('policy', peer);
        for (const partition of [-1, count!, 0.5]) await expect(stream.publish({}, { partition })).rejects.toThrow(/partition/i);
        await expect(stream.publish({}, { key: '\ud800' })).rejects.toThrow(/Unicode/);
        expect(await stream.getInfo()).toMatchObject({ length: 0, groups: 0, lag: 0 });
        const legacy = new StreamImpl('legacy-policy', adapter);
        await legacy.publish({ retained: true });
        await expect(adapter.configureStream('legacy-policy', 2)).rejects.toThrow(/migration/);
        expect(await legacy.getMessages('-', '+')).toHaveLength(1);
        await stream.close(); await legacy.close();
      } finally { await peer.cleanup(); }
    });
    it('retains independent partition cursors across reopen, initial cutoffs, ranges and trimming', async () => {
      const stream = new StreamImpl<{ value: number }>('partition-progress', adapter, { partitions: 2 });
      const old = [await stream.publish({ value: 0 }, { partition: 0 }), await stream.publish({ value: 1 }, { partition: 1 })];
      const seen: string[] = [];
      const first = stream.createConsumer('first', { groupId: 'progress', maxInFlight: 2 });
      await first.subscribe(async message => { seen.push(message.id); await message.ack(); });
      const published = [await stream.publish({ value: 2 }, { partition: 0 }), await stream.publish({ value: 3 }, { partition: 1 })];
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen.sort()).toEqual([...published].sort());
      await first.close();
      const peerPool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      const peer = new PostgresAdapter({ schema, db: drizzle(peerPool), pollInterval: 10 });
      const reopened = new StreamImpl<{ value: number }>('partition-progress', peer);
      const second = reopened.createConsumer('second', { groupId: 'progress', fromBeginning: true, maxInFlight: 2 });
      try {
        await second.subscribe(async message => { seen.push(message.id); await message.ack(); });
        const last = await reopened.publish({ value: 4 }, { partition: 0 });
        await vi.waitFor(() => expect(seen).toHaveLength(3));
        expect(seen).toContain(last);
        expect(seen.some(id => old.includes(id))).toBe(false);
        expect((await reopened.getMessages(published[0], last)).map(message => message.data.value)).toEqual([2, 3, 4]);
        await second.close();
        expect(await reopened.trim({ maxLength: 3 })).toBe(2);
        expect(await reopened.getInfo()).toMatchObject({ length: 3, groups: 1, lag: 0 });
        const replay: number[] = [];
        expect(await reopened.replay(0, async message => { replay.push(message.data.value); })).toBe(3);
        expect(replay).toEqual([2, 3, 4]);
      } finally { await second.close(); await reopened.close(); await stream.close(); await peer.cleanup(); await peerPool.end(); }
    });
    it('fences expired partition receipts without allowing a later key to pass its successor', async () => {
      const stream = new StreamImpl('partition-fence', adapter, { partitions: 2 });
      const firstId = await stream.publish({}, { partition: 0 });
      const laterId = await stream.publish({}, { partition: 0 });
      const otherId = await stream.publish({}, { partition: 1 });
      const old: import('../../stream/types.js').Message[] = [];
      const next: import('../../stream/types.js').Message[] = [];
      let releaseOld!: () => void, releaseNext!: () => void;
      const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
      const nextGate = new Promise<void>(resolve => { releaseNext = resolve; });
      const peerPool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      const peer = new PostgresAdapter({ schema, db: drizzle(peerPool), pollInterval: 10 });
      let successor: import('../../stream/types.js').Subscription | undefined;
      const original = await adapter.consume('partition-fence', 'fenced', 'old', async message => { old.push(message); await oldGate; }, { groupId: 'fenced', fromBeginning: true, maxInFlight: 1, autoCommit: false, visibilityTimeout: 5000 });
      try {
        await vi.waitFor(() => expect(old).toHaveLength(1));
        expect(old[0].id).toBe(firstId);
        await pool.query(`UPDATE "${schema}".flowfn_deliveries SET delivered_at=0 WHERE message_id=$1`, [firstId]);
        successor = await peer.consume('partition-fence', 'fenced', 'new', async message => {
          next.push(message);
          if (message.id === firstId) await nextGate;
          else await message.ack();
        }, { groupId: 'fenced', fromBeginning: true, maxInFlight: 2, autoCommit: false, visibilityTimeout: 5000 });
        await vi.waitFor(() => expect(next.map(message => message.id)).toContain(otherId));
        expect(next.map(message => message.id)).toContain(firstId);
        expect(next.map(message => message.id)).not.toContain(laterId);
        await old[0].ack();
        expect((await pool.query(`SELECT consumer_id,state FROM "${schema}".flowfn_deliveries WHERE message_id=$1`, [firstId])).rows[0]).toEqual({ consumer_id: 'new', state: 'active' });
        await next.find(message => message.id === firstId)!.ack();
        releaseNext();
        await vi.waitFor(() => expect(next.map(message => message.id)).toContain(laterId));
      } finally { releaseOld(); releaseNext(); await original.unsubscribe(); await successor?.unsubscribe(); await stream.close(); await peer.cleanup(); await peerPool.end(); }
    });
    it('recovers the same partition message after SIGKILL before delivering its successor', async () => {
      const stream = new StreamImpl('partition-crash', adapter, { partitions: 2 });
      const first = await stream.publish({}, { partition: 0 });
      const later = await stream.publish({}, { partition: 0 });
      const other = await stream.publish({}, { partition: 1 });
      const child = fork(resolve('scripts/partition-crash-worker.mjs'), [], {
        env: { ...process.env, FLOWFN_PARTITION_CRASH_CONFIG: JSON.stringify({ schema, stream: 'partition-crash', group: 'crash-group' }) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let errors = '';
      child.stderr?.on('data', data => { errors += data; });
      let subscription: import('../../stream/types.js').Subscription | undefined;
      const peerPool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      const peer = new PostgresAdapter({ schema, db: drizzle(peerPool), pollInterval: 10 });
      try {
        const initial = await new Promise<unknown>((done, reject) => {
          const timer = setTimeout(() => reject(new Error(`Partition child readiness timeout: ${errors}`)), 10_000);
          child.once('message', value => { clearTimeout(timer); done(value); });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); reject(new Error(`Partition child exited ${code}: ${errors}`)); });
        });
        expect(initial).toEqual({ id: first, partition: 0 });
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        expect(child.signalCode).toBe('SIGKILL');
        const seen: string[] = [];
        subscription = await peer.consume('partition-crash', 'crash-group', 'successor', async message => {
          seen.push(message.id); await message.ack();
        }, { groupId: 'crash-group', fromBeginning: true, maxInFlight: 2, autoCommit: false, visibilityTimeout: 300 });
        await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 5000 });
        expect(seen).toContain(other);
        expect(seen.filter(id => id !== other)).toEqual([first, later]);
        expect(await peer.getStreamInfo('partition-crash')).toMatchObject({ partitions: 2, groups: 1, lag: 0 });
      } finally {
        if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
        await subscription?.unsubscribe(); await stream.close(); await peer.cleanup(); await peerPool.end();
      }
    });
    it('installs the matching claim index on an existing schema without rewriting queued jobs', async () => {
      await adapter.enqueue('index-upgrade', new JobImpl('work', { retained: true }, { jobId: 'retained', lifo: true, priority: 4 }));
      const before = (await pool.query(`SELECT * FROM "${schema}".flowfn_jobs`)).rows;
      await pool.query(`DROP INDEX "${schema}".flowfn_jobs_claim_order`);
      await adapter.initialize();
      await adapter.initialize();
      const definition = (await pool.query(`SELECT i.indisvalid,pg_get_indexdef(i.indexrelid,2,true) AS priority,(i.indoption[1] & 3) AS priority_flags,pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='flowfn_jobs_claim_order'`, [schema])).rows;
      expect(definition).toHaveLength(1);
      expect(definition[0].indisvalid).toBe(true);
      expect(definition[0].priority).toBe('priority');
      expect(definition[0].priority_flags).toBe(3); // DESC and NULLS FIRST, matching dequeue.
      expect(definition[0].predicate).toContain("'waiting'::text");
      expect(definition[0].predicate).toContain("'delayed'::text");
      expect((await pool.query(`SELECT * FROM "${schema}".flowfn_jobs`)).rows).toEqual(before);
      const metadata = getTableConfig(getPostgresSchema(schema).jobs).indexes.find(index => index.config.name === 'flowfn_jobs_claim_order');
      expect(metadata?.config.columns[1]).toMatchObject({ indexConfig: { order: 'desc', nulls: 'first' } });
      expect((await adapter.dequeue('index-upgrade'))?.id).toBe('retained');
    });
    it.each([false, true])('preserves durable queue insertion order despite tied timestamps and heap updates (lifo=%s)', async lifo => {
      for (const id of ['a', 'b', 'c']) await adapter.enqueue('ordered', new JobImpl('work', {}, { jobId: id, lifo }));
      await pool.query(`UPDATE "${schema}".flowfn_jobs SET timestamp=1000,available_at=0`);
      const first = (await adapter.getJob('ordered', 'a'))!;
      first.progress = 25; await adapter.saveJob('ordered', first);
      const reopenedPool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      const reopened = new PostgresAdapter({ db: drizzle(reopenedPool), schema });
      await reopened.initialize();
      try {
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push((await reopened.dequeue('ordered'))!.id);
        expect(ids).toEqual(lifo ? ['c', 'b', 'a'] : ['a', 'b', 'c']);
      } finally { await reopened.cleanup(); await reopenedPool.end(); }
    });
    it('keeps SQL bigint ordering across priority, mixed modes, duplicate creation and reenqueue', async () => {
      await pool.query(`SELECT setval('"${schema}".flowfn_jobs_enqueue_order_seq'::regclass,9007199254740992,true)`);
      const peer = new PostgresAdapter({ db: drizzle(pool), schema });
      const add = async (id: string, opts: { lifo?: boolean; priority?: number } = {}) => peer.createJob('mixed-order', new JobImpl('work', {}, { jobId: id, ...opts }));
      try {
        await add('fifo-first'); await add('lifo-first', { lifo: true }); await add('fifo-last');
        await add('lifo-last', { lifo: true }); await add('priority', { priority: 10 });
        const first = (await adapter.getJob('mixed-order', 'fifo-first'))!;
        await adapter.saveJob('mixed-order', first);
        await add('fifo-first');
        await pool.query(`UPDATE "${schema}".flowfn_jobs SET timestamp=1000,available_at=0`);
        const values = (await pool.query(`SELECT enqueue_order::text AS value FROM "${schema}".flowfn_jobs ORDER BY enqueue_order`)).rows.map(row => row.value);
        expect(values).toEqual(['9007199254740993','9007199254740994','9007199254740995','9007199254740996','9007199254740997']);
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push((await adapter.dequeue('mixed-order'))!.id);
        expect(ids).toEqual(['priority','lifo-last','lifo-first','fifo-first','fifo-last']);
        await adapter.enqueue('mixed-order', (await adapter.getJob('mixed-order', 'fifo-last'))!);
        await peer.enqueue('mixed-order', (await adapter.getJob('mixed-order', 'fifo-first'))!);
        expect((await peer.dequeue('mixed-order'))!.id).toBe('fifo-last');
        expect((await peer.dequeue('mixed-order'))!.id).toBe('fifo-first');
      } finally { await peer.cleanup(); }
    });
    it('requires explicit atomic ordering migration and preserves idempotence after rollback/reopen', async () => {
      for (const id of ['z','a','m']) await adapter.enqueue('historical', new JobImpl('work', { id }, { jobId: id }));
      await pool.query(`ALTER TABLE "${schema}".flowfn_jobs DROP COLUMN enqueue_order CASCADE; UPDATE "${schema}".flowfn_jobs SET timestamp=1000,available_at=0`);
      const before = (await pool.query(`SELECT queue,id,data FROM "${schema}".flowfn_jobs ORDER BY id`)).rows;
      await expect(adapter.initialize()).rejects.toThrow('migration required');
      const db = drizzle(pool);
      const failing = new PostgresAdapter({ schema, db: { execute: db.execute.bind(db), transaction: (callback: (tx: unknown) => Promise<void>) => db.transaction(async tx => { await callback(tx); throw new Error('forced migration rollback'); }) } });
      await expect(failing.migrateQueueOrderingSchema()).rejects.toThrow('forced migration rollback');
      await failing.cleanup();
      expect((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='flowfn_jobs' AND column_name='enqueue_order'`, [schema])).rows).toHaveLength(0);
      expect((await pool.query(`SELECT queue,id,data FROM "${schema}".flowfn_jobs ORDER BY id`)).rows).toEqual(before);
      const peer = new PostgresAdapter({ db: drizzle(pool), schema });
      try {
        await Promise.all([adapter.migrateQueueOrderingSchema(), peer.migrateQueueOrderingSchema()]);
        await peer.initialize();
        const order = (await pool.query(`SELECT id,enqueue_order::text FROM "${schema}".flowfn_jobs ORDER BY enqueue_order`)).rows;
        expect(order.map(row => row.id)).toEqual(['a','m','z']);
        await peer.migrateLegacySchema();
        expect((await pool.query(`SELECT id,enqueue_order::text FROM "${schema}".flowfn_jobs ORDER BY enqueue_order`)).rows).toEqual(order);
        expect((await pool.query(`SELECT queue,id,data FROM "${schema}".flowfn_jobs ORDER BY id`)).rows).toEqual(before);
        await peer.enqueue('historical', new JobImpl('work', {}, { jobId: 'new' }));
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push((await peer.dequeue('historical'))!.id);
        expect(ids).toEqual(['a','m','z','new']);
      } finally { await peer.cleanup(); }
    });
    it("waits for an in-flight consumer transaction before cleanup returns", async () => {
      const db = drizzle(pool);
      let release!: () => void, began!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { began = resolve; });
      const slow = new PostgresAdapter({ schema, db: {
        execute: db.execute.bind(db),
        transaction: (callback: (tx: unknown) => Promise<unknown>) => db.transaction(async tx => callback({
          execute: async (statement: Parameters<typeof tx.execute>[0]) => {
            const query = typeof statement === 'string' ? statement : new PgDialect().sqlToQuery(statement.getSQL()).sql;
            // Hold the polling ownership transaction, not group initialization.
            if (query.startsWith('SELECT id FROM') && query.includes('flowfn_consumer_groups') && query.includes('FOR UPDATE')) {
              began(); await gate;
            }
            return tx.execute(statement);
          },
        })),
      } });
      let stopping: Promise<void> | undefined;
      try {
        await slow.consume("cleanup", "group", "worker", async () => {});
        await started;
        let stopped = false;
        stopping = slow.cleanup().then(() => { stopped = true; });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(stopped).toBe(false);
        release();
        await stopping;
        expect(stopped).toBe(true);
      } finally { release(); await stopping; await slow.cleanup(); }
    });
    it("persists batch results and enforces per-job timeout and retention", async () => {
      const queue = new QueueImpl("batch-runtime", adapter);
      try {
        const good = await queue.add("work", 2);
        const removed = await queue.add("work", 3, { removeOnComplete: true });
        const timed = await queue.add("work", 4, { timeout: 10 });
        queue.processBatch("work", { batchSize: 3, maxWait: 50 }, async jobs => {
          await new Promise(resolve => setTimeout(resolve, 40));
          return jobs.map(job => job.data * 2);
        });
        await queue.drain();
        expect((await queue.getJob(good.id))?.returnvalue).toBe(4);
        expect(await queue.getJob(removed.id)).toBeNull();
        expect((await queue.getJob(timed.id))?.state).toBe("failed");
        expect((await queue.getJob(timed.id))?.failedReason).toBe("Job timed out");
      } finally { await queue.close(); }
    });
    it("reclaims expired queue leases and fences stale writes, retries and acknowledgments", async () => {
      const original = new JobImpl("work", { value: 1 });
      await adapter.createJob("leases", original);
      // A fast worker clock must not extend durable lease ownership.
      const skew = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      let stale: NonNullable<Awaited<ReturnType<typeof adapter.dequeue>>>;
      try { stale = (await adapter.dequeue("leases", undefined, 25))!; }
      finally { skew.mockRestore(); }
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(await adapter.renewJobLease("leases", stale.id, stale.lease!.token, 100)).toBe(false);
      const recovered = await adapter.recoverStalledJobs("leases", 1);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].stalledCount).toBe(1);
      const current = (await adapter.dequeue("leases", undefined, 1000))!;
      expect(current.lease!.token).not.toBe(stale.lease!.token);
      await expect(adapter.saveJob("leases", { ...stale, state: "completed", returnvalue: "stale" })).rejects.toThrow("lease lost");
      await expect(adapter.enqueue("leases", stale)).rejects.toThrow("lease lost");
      await expect(adapter.ack("leases", stale.id, stale.lease!.token)).rejects.toThrow("lease lost");
      await expect(adapter.nack("leases", stale.id, true, stale.lease!.token)).rejects.toThrow("lease lost");
      await adapter.saveJob("leases", { ...current, state: "completed", returnvalue: "current" });
      expect((await adapter.getJob("leases", stale.id))!.returnvalue).toBe("current");
      await expect(adapter.saveJob("leases", stale)).rejects.toThrow("lease lost");
    });
    it('does not restart native renewal after completed jobs release their lease', async () => { await queueReleasedReplyContract(adapter); });
    it('fences expired native renewal replies without reviving handlers', async () => { await queueExpiredReplyContract(adapter); });
    it('retains ownership across delayed native claim and renewal replies', async () => { await queueReplyLeaseContract(adapter); });
    it("renews running jobs and terminally fails repeated stalled claims", async () => {
      const queue = new QueueImpl("renewed", adapter, { leaseDuration: 1000, stalledInterval: 20 });
      try {
        const job = await queue.add("long", {});
        queue.process(async () => { await new Promise(resolve => setTimeout(resolve, 2250)); return 42; });
        await queue.drain();
        expect((await queue.getJob(job.id))!.returnvalue).toBe(42);
        expect((await queue.getJob(job.id))!.stalledCount ?? 0).toBe(0);
      } finally { await queue.close(); }
      await adapter.createJob("stalled", new JobImpl("work", {}));
      const first = (await adapter.dequeue("stalled", undefined, 20))!;
      await new Promise(resolve => setTimeout(resolve, 35));
      await adapter.recoverStalledJobs("stalled", 1);
      await adapter.dequeue("stalled", undefined, 20);
      await new Promise(resolve => setTimeout(resolve, 35));
      const terminal = await adapter.recoverStalledJobs("stalled", 1);
      expect(terminal[0].state).toBe("failed");
      expect((await adapter.getJob("stalled", first.id))!.stalledCount).toBe(2);
    });
    it("atomically deduplicates competing queue instances without overwriting IDs", async () => {
      const queues = Array.from({ length: 12 }, () => new QueueImpl("dedup", adapter));
      try {
        const keyed = await Promise.all(queues.map((queue, i) => queue.add("work", { i }, { deduplicationKey: "shared" })));
        expect(new Set(keyed.map(job => job.id)).size).toBe(1);
        expect(await adapter.getAllJobs("dedup")).toHaveLength(1);
        const ids = await Promise.all(queues.map((queue, i) => queue.add("id", { i }, { jobId: "fixed" })));
        expect(new Set(ids.map(job => JSON.stringify(job.data))).size).toBe(1);
        const payloads = await Promise.all(queues.map(queue => queue.add("payload", { nested: [1, 2] }, { preventDuplicates: true })));
        expect(new Set(payloads.map(job => job.id)).size).toBe(1);
        const first = keyed[0];
        await first.moveToFailed(new Error("done"));
        const next = await queues[0].add("work", {}, { deduplicationKey: "shared" });
        expect(next.id).not.toBe(first.id);
        await expect(first.retry()).rejects.toThrow("deduplication key");
        expect((await adapter.getJob("dedup", first.id))?.state).toBe("failed");
        const other = new QueueImpl("other-dedup", adapter);
        expect((await other.add("work", {}, { deduplicationKey: "shared" })).id).not.toBe(next.id);
        await other.close();
      } finally { await Promise.all(queues.map(queue => queue.close())); }
    });
    it("claims jobs atomically with SKIP LOCKED and scopes identical IDs by queue", async () => {
      for (let i = 0; i < 20; i++)
        await adapter.enqueue(
          "queue",
          new JobImpl("work", { i }, { jobId: String(i) }),
        );
      await adapter.enqueue(
        "other",
        new JobImpl("work", { secret: true }, { jobId: "0" }),
      );
      const independentPool = new Pool({ connectionString: process.env.FLOWFN_POSTGRES_URL });
      const independent = new PostgresAdapter({ db: drizzle(independentPool), schema });
      try {
        const claimed = await Promise.all(
          Array.from({ length: 30 }, (_, index) => (index % 2 ? independent : adapter).dequeue("queue")),
        );
        const jobs = claimed.filter((job): job is NonNullable<typeof job> => job !== null);
        expect(jobs).toHaveLength(20);
        expect(new Set(jobs.map(job => job.id)).size).toBe(20);
        expect(new Set(jobs.map(job => job.lease!.token)).size).toBe(20);
        for (const job of jobs) expect((await independent.getJob("queue", job.id))?.lease?.token).toBe(job.lease!.token);
        expect((await adapter.getJob("other", "0"))!.data).toEqual({ secret: true });
      } finally { await independent.cleanup(); await independentPool.end(); }
    });
    it("persists actual job failure, retry and result through queue workers", async () => {
      const queue = new QueueImpl<number>("queue", adapter);
      let attempts = 0;
      const success = await queue.add("work", 1, {
          attempts: 2,
          backoff: { type: "fixed", delay: 20 },
        }),
        failure = await queue.add("work", 2);
      queue.process(async (job) => {
        if (job.data === 2) throw new Error("permanent");
        if (attempts++ === 0) throw new Error("transient");
        await job.updateProgress(100);
        return 42;
      });
      await queue.drain();
      expect((await queue.getJob(success.id))!.returnvalue).toBe(42);
      expect((await queue.getJob(success.id))!.attemptsMade).toBe(1);
      expect((await queue.getJob(failure.id))!.state).toBe("failed");
      expect(await queue.clean(0, "failed")).toBe(1);
      await queue.close();
    });
    it("keeps consumer group ownership, backpressure and negative acknowledgments durable", async () => {
      const stream = new StreamImpl<number>("stream", adapter),
        seen: Message<number>[] = [],
        other: Message<number>[] = [];
      const a = stream.createConsumer("a", {
          groupId: "group",
          autoCommit: false,
        }),
        b = stream.createConsumer("b", { groupId: "group", autoCommit: false });
      await a.subscribe(async (message) => {
        seen.push(message);
      });
      await b.subscribe(async (message) => {
        other.push(message);
      });
      await stream.publishBatch([1, 2, 3].map((data) => ({ data })));
      await vi.waitFor(() => expect(seen.length + other.length).toBe(2));
      expect((await stream.getInfo()).lag).toBe(3);
      const first = seen[0] ?? other[0];
      await first.nack(true);
      await vi.waitFor(() => expect(seen.length + other.length).toBe(3));
      expect(
        [...seen, ...other].filter((message) => message.id === first.id),
      ).toHaveLength(2);
      const delivery = [...seen, ...other]
        .filter((message) => message.id === first.id)
        .at(-1)!;
      await delivery.ack();
      await vi.waitFor(() =>
        expect(
          new Set([...seen, ...other].map((message) => message.id)).size,
        ).toBe(3),
      );
      expect((await stream.getInfo()).groups).toBe(1);
      await stream.close();
    });
    it("uses offsets for same-timestamp history and does not lose messages across polling pages", async () => {
      const stream = new StreamImpl<number>("stream", adapter),
        seen: number[] = [];
      await stream.subscribe(async (message) => {
        seen.push(message.data);
      });
      const ids = await stream.publishBatch(
        Array.from({ length: 120 }, (_, data) => ({ data })),
      );
      await vi.waitFor(() => expect(seen).toHaveLength(120));
      expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i));
      expect((await stream.getMessages(ids[0], ids[119])).length).toBe(120);
      expect(await stream.trim({ maxLength: 0 })).toBe(120);
      expect((await stream.getInfo()).length).toBe(0);
      await stream.close();
    });
    it("reclaims expired delivery leases while refusing a stale acknowledgment", async () => {
      const stream = new StreamImpl<number>("stream", adapter),
        seen: Message<number>[] = [],
        recovered: Message<number>[] = [];
      const a = stream.createConsumer("a", {
        groupId: "group",
        autoCommit: false,
      });
      await a.subscribe(async (message) => {
        seen.push(message);
      });
      await stream.publish(1);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await a.pause();
      await pool.query(`UPDATE "${schema}".flowfn_deliveries SET delivered_at=0`);
      const b = stream.createConsumer("b", {
        groupId: "group",
        autoCommit: false,
        visibilityTimeout: 1000,
      });
      await b.subscribe(async (message) => {
        recovered.push(message);
      });
      await vi.waitFor(() => expect(recovered).toHaveLength(1));
      await seen[0].ack();
      expect(
        (await pool.query(`SELECT state FROM "${schema}".flowfn_deliveries`))
          .rows[0].state,
      ).toBe("active");
      await recovered[0].ack();
      expect(
        (await pool.query(`SELECT state FROM "${schema}".flowfn_deliveries`))
          .rows[0].state,
      ).toBe("completed");
      await stream.close();
    });
    it.each(['ack', 'nack', 'unsubscribe'] as const)('uses server time and rejects expired delivery %s before takeover', async action => {
      const stream = new StreamImpl<number>('server-clock', adapter);
      const seen: Message<number>[] = [];
      const consumer = stream.createConsumer('owner', { groupId: 'group', autoCommit: false, visibilityTimeout: 1000 });
      await consumer.subscribe(async message => { seen.push(message); });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
      try {
        await stream.publish(1);
        await vi.waitFor(() => expect(seen).toHaveLength(1));
      } finally { clock.mockRestore(); }
      await consumer.pause();
      const [{ skew }] = (await pool.query(`SELECT abs(delivered_at-floor(extract(epoch from clock_timestamp())*1000)) AS skew FROM "${schema}".flowfn_deliveries`)).rows;
      expect(Number(skew)).toBeLessThan(1000);
      await pool.query(`UPDATE "${schema}".flowfn_deliveries SET delivered_at=0`);
      if (action === 'ack') await seen[0].ack();
      else if (action === 'nack') await seen[0].nack(true);
      else await consumer.close();
      expect((await pool.query(`SELECT state FROM "${schema}".flowfn_deliveries`)).rows[0].state).toBe('active');
      await consumer.close();
      expect((await pool.query(`SELECT state FROM "${schema}".flowfn_deliveries`)).rows[0].state).toBe('active');
      await stream.close();
    });
    it("migrates legacy data transactionally while retaining original tables as backups", async () => {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE; CREATE SCHEMA "${schema}";
  CREATE TABLE "${schema}".flowfn_jobs(id text PRIMARY KEY,queue text,name text,state text,data jsonb,opts jsonb,timestamp bigint,delay bigint,attempts_made integer,progress integer,return_value jsonb,processed_on bigint,finished_on bigint,failed_reason text,stacktrace jsonb);
  INSERT INTO "${schema}".flowfn_jobs VALUES ('legacy-job','queue','task','completed','{"input":1}','{}',100,0,1,100,'42',110,120,NULL,'[]');
  CREATE TABLE "${schema}".flowfn_messages(id text PRIMARY KEY,stream text,data jsonb,headers jsonb,timestamp bigint,partition integer,key text);
  INSERT INTO "${schema}".flowfn_messages VALUES ('legacy-message','stream','{"message":1}','{}',100,NULL,NULL),('legacy-label','stream','{"message":2}','{}',101,7,'historical');`);
      await expect(adapter.initialize()).rejects.toThrow("Legacy");
      await adapter.migrateLegacySchema();
      expect(await adapter.getJob("queue", "legacy-job")).toMatchObject({
        state: "completed",
        returnvalue: 42,
        data: { input: 1 },
        attemptsMade: 1,
      });
      expect((await adapter.getMessages("stream", "-", "+"))[0].data).toEqual({
        message: 1,
      });
      expect((await adapter.getMessages("stream", "-", "+"))[1]).toMatchObject({ partition: 7, key: 'historical' });
      await expect(adapter.configureStream('stream', 8)).rejects.toThrow(/migration/);
      expect(
        (await pool.query(`SELECT data FROM "${schema}".flowfn_jobs_legacy_v0`))
          .rows[0].data,
      ).toEqual({ input: 1 });
      await adapter.migrateLegacySchema();
      expect(await adapter.getAllJobs("queue")).toHaveLength(1);
    });
  },
);
