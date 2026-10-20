import { queueClockContract } from '../storage/queue-clock-contract.js';
import { workflowCancelContract } from '../storage/workflow-cancel-contract.js';
import { streamFilterContract } from '../storage/stream-filter-contract.js';
import { streamRenewalContract, streamLossContract, streamUnsubscribeContract } from '../storage/stream-lease-contract.js';
import { shutdownContract } from '../storage/shutdown-contract.js';
import { telemetryContract } from '../storage/telemetry-contract.js';
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { workflowControlContract } from '../storage/workflow-control-contract.js';
import { workflowCrashContract } from '../storage/workflow-crash-contract.js';
import { schedulerContract } from '../storage/scheduler-contract.js';
import { workerOwnershipContract, workerPoolContract } from '../storage/worker-contract.js';
import { RedisAdapter } from "./redis.js";
import { JobImpl } from "../queue/job.js";
import { QueueImpl } from "../queue/queue.js";
import { StreamImpl } from "../stream/stream.js";
import type { Message } from "../stream/types.js";

describe.skipIf(!process.env.FLOWFN_REDIS_URL)(
  "Redis native contract (requires FLOWFN_REDIS_URL)",
  () => {
    let adapter: RedisAdapter;
    let redis: Redis;
    let prefix: string;
    it.each([false, true])('delivers remote workflow cancellation across process ownership (restart=%s)', async restart => { await workflowCancelContract(adapter, 'redis', prefix, restart); });
    it('filters subscribers and group deliveries without losing history or retrying skipped messages', async () => { await streamFilterContract(adapter); });
    it('aborts active stream handlers on unsubscribe and requeues their receipt', async () => { await streamUnsubscribeContract(adapter); });
    it('renews active stream handlers across delivery expiry', async () => { await streamRenewalContract(adapter); });
    it('aborts stream handlers after delivery ownership expires and fences late acknowledgment', async () => { await streamLossContract(adapter, (stream, id) => redis.xclaim(`${prefix}stream:${stream}`, 'group', 'a', 0, id, 'IDLE', 2000)); });
    it('bounds global shutdown and fences late callback results', async () => { await shutdownContract(adapter); });
    it('exports native operation spans and reports callback failures', async () => { await telemetryContract(adapter); });
    it('bounds worker shutdown and fences abandoned callbacks', async () => { await workerOwnershipContract(adapter, 1000); });
    it('scales independent worker groups without closing shared queues', async () => { await workerPoolContract(adapter); });
    it('recovers a schedule occurrence after SIGKILL with a stable idempotency identity', async () => { await workflowCrashContract(adapter, 'redis', prefix, true); });
    it('shares durable schedule ownership and preserves attempts across restart', async () => { await schedulerContract(adapter, 1000); });
    it('recovers a SIGKILL checkpoint in a new process without repeating effects', async () => { await workflowCrashContract(adapter, 'redis', prefix); });
    it('enforces durable workflow ownership and concurrent catalogs', async () => { await workflowControlContract(adapter, 1000); });
    it.each([-3_600_000, 3_600_000])('uses storage queue clocks under client skew %s', async skew => {
      await queueClockContract(adapter, skew, false);
      await queueClockContract(adapter, skew, true);
    });
    beforeEach(() => {
      redis = new Redis(process.env.FLOWFN_REDIS_URL!);
      prefix = `flowfn-test-${randomUUID()}:`;
      adapter = new RedisAdapter({ connection: redis, prefix });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      await adapter.cleanup();
    });
    it("uses cached Lua and recovers after Redis forgets scripts", async () => {
      await redis.script("FLUSH");
      const source = vi.spyOn(redis, "eval");
      const cached = vi.spyOn(redis, "evalsha");
      await adapter.createJob("scripts", new JobImpl("work", 1));
      expect(source).toHaveBeenCalledTimes(1);
      await adapter.createJob("scripts", new JobImpl("work", 2));
      expect(source).toHaveBeenCalledTimes(1);
      await redis.script("FLUSH");
      await adapter.createJob("scripts", new JobImpl("work", 3));
      expect(source).toHaveBeenCalledTimes(2);
      expect(cached).toHaveBeenCalledTimes(3);
      expect(await redis.hlen(`${prefix}jobs:scripts`)).toBe(3);
    });
    it("does not replay Lua source after an ambiguous transport error", async () => {
      const source = vi.spyOn(redis, "eval");
      const failure = new Error("connection lost after write");
      vi.spyOn(redis, "evalsha").mockRejectedValueOnce(failure);
      await expect(adapter.createJob("scripts", new JobImpl("work", 1))).rejects.toBe(failure);
      expect(source).not.toHaveBeenCalled();
    });
    it("preserves FIFO ties and LIFO priority without scanning completed history", async () => {
      const sameTime = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      try {
        for (let i = 0; i < 50; i++) await adapter.createJob("order", new JobImpl("work", i, { jobId: String(i) }));
        await adapter.createJob("order", new JobImpl("work", "lifo-first", { lifo: true }));
        await adapter.createJob("order", new JobImpl("work", "lifo-last", { lifo: true }));
      } finally { sameTime.mockRestore(); }
      expect((await adapter.dequeue("order"))?.data).toBe("lifo-last");
      expect((await adapter.dequeue("order"))?.data).toBe("lifo-first");
      for (let i = 0; i < 50; i++) {
        const job = (await adapter.dequeue("order"))!;
        expect(job.data).toBe(i);
        await adapter.saveJob("order", { ...job, state: "completed" });
      }
      expect(await adapter.dequeue("order")).toBeNull();
      for (let i = 0; i < 65; i++) await adapter.createJob("order", new JobImpl("blocked", i, { waitFor: ["missing"] }));
      const runnable = await adapter.createJob("order", new JobImpl("ready", "ready"));
      expect((await adapter.dequeue("order", "ready"))?.id).toBe(runnable.id);
      expect(await adapter.dequeue("order")).toBeNull();
    });
    it("rebuilds the ready index for existing queues without losing delayed jobs", async () => {
      const waiting = new JobImpl("work", "waiting", { priority: 1 });
      const delayed = new JobImpl("work", "delayed", { delay: 20, priority: 10 });
      delayed.state = "delayed";
      await redis.hset(`${prefix}jobs:legacy-index`, waiting.id, JSON.stringify(waiting), delayed.id, JSON.stringify(delayed));
      expect((await adapter.dequeue("legacy-index"))?.id).toBe(waiting.id);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect((await adapter.dequeue("legacy-index"))?.id).toBe(delayed.id);
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
    it("atomically claims jobs without duplicate delivery and isolates identical IDs by queue", async () => {
      for (let i = 0; i < 20; i++)
        await adapter.enqueue(
          "queue",
          new JobImpl("work", { i }, { jobId: String(i) }),
        );
      await adapter.enqueue(
        "other",
        new JobImpl("work", { secret: true }, { jobId: "0" }),
      );
      const claimed = await Promise.all(
        Array.from({ length: 30 }, () => adapter.dequeue("queue")),
      );
      expect(new Set(claimed.filter(Boolean).map((job) => job!.id)).size).toBe(
        20,
      );
      expect(claimed.filter(Boolean)).toHaveLength(20);
      expect((await adapter.getJob("other", "0"))!.data).toEqual({
        secret: true,
      });
      expect((await adapter.getQueueStats("queue")).active).toBe(20);
    });
    it("honors priority, names and delayed availability", async () => {
      await adapter.enqueue("queue", new JobImpl("work", 1, { priority: 1 }));
      await adapter.enqueue("queue", new JobImpl("work", 2, { priority: 10 }));
      await adapter.enqueue("queue", new JobImpl("later", 3, { delay: 40 }));
      expect((await adapter.dequeue("queue", "work"))!.data).toBe(2);
      expect(await adapter.dequeue("queue", "later")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await adapter.dequeue("queue", "later"))!.data).toBe(3);
    });
    it("persists final results, failure reasons, retries and cleanup through actual queue workers", async () => {
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
        return 42;
      });
      await queue.drain();
      expect((await queue.getJob(success.id))!.returnvalue).toBe(42);
      expect((await queue.getJob(failure.id))!.state).toBe("failed");
      expect((await queue.getJob(failure.id))!.failedReason).toBe("permanent");
      expect(await queue.clean(0, "failed")).toBe(1);
      await queue.close();
    });
    it("persists stream history and distributes each group delivery once with ack backpressure", async () => {
      const stream = new StreamImpl<number>("stream", adapter),
        first: Message<number>[] = [],
        second: Message<number>[] = [];
      const a = stream.createConsumer("a", {
          groupId: "group",
          autoCommit: false,
        }),
        b = stream.createConsumer("b", { groupId: "group", autoCommit: false });
      await a.subscribe(async (message) => {
        first.push(message);
      });
      await b.subscribe(async (message) => {
        second.push(message);
      });
      const ids = await stream.publishBatch(
        [1, 2, 3].map((data) => ({ data })),
      );
      await vi.waitFor(() => expect(first.length + second.length).toBe(2));
      expect((await stream.getInfo()).lag).toBe(3);
      await (first[0] ?? second[0]).ack();
      await vi.waitFor(() => expect(first.length + second.length).toBe(3));
      expect(
        new Set([...first, ...second].map((message) => message.id)).size,
      ).toBe(3);
      expect(
        (await stream.getMessages(ids[0], ids[2])).map(
          (message) => message.data,
        ),
      ).toEqual([1, 2, 3]);
      expect((await stream.getInfo()).groups).toBe(1);
      await stream.close();
    });
    it("requeues nacks and restores a crashed consumer pending delivery after its lease", async () => {
      const stream = new StreamImpl<number>("stream", adapter),
        seen: Message<number>[] = [];
      const first = stream.createConsumer("first", {
        groupId: "group",
        autoCommit: false,
      });
      await first.subscribe(async (message) => {
        seen.push(message);
      });
      await stream.publish(1);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await seen[0].nack(true);
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      // Simulate a dead owner by pausing delivery; another consumer reclaims the unacked record.
      await first.pause();
      await redis.xclaim(`${prefix}stream:stream`, "group", "first", 0, seen[1].id, "IDLE", 2000);
      const recovered: Message<number>[] = [];
      const second = stream.createConsumer("second", {
        groupId: "group",
        autoCommit: false,
        visibilityTimeout: 1000,
      });
      await second.subscribe(async (message) => {
        recovered.push(message);
      });
      await vi.waitFor(() => expect(recovered).toHaveLength(1));
      await seen[1].ack();
      expect(
        ((await redis.xpending(`${prefix}stream:stream`, "group")) as any)[0],
      ).toBe(1);
      await recovered[0].ack();
      expect(
        ((await redis.xpending(`${prefix}stream:stream`, "group")) as any)[0],
      ).toBe(0);
      await stream.close();
    });
    it.each(['ack', 'nack', 'unsubscribe'] as const)('fences stale %s after same-name takeover', async action => {
      const seen: Message<number>[] = [], replacement: Message<number>[] = [];
      const options = { groupId: 'tokens', autoCommit: false, visibilityTimeout: 1000 };
      const first = await adapter.consume('tokens', 'tokens', 'shared-name', async message => { seen.push(message); }, options);
      const id = await new StreamImpl<number>('tokens', adapter).publish(1);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await first.pause!();
      await redis.xclaim(`${prefix}stream:tokens`, 'tokens', 'shared-name', 0, id, 'IDLE', 2000);
      const second = await adapter.consume('tokens', 'tokens', 'shared-name', async message => { replacement.push(message); }, options);
      await vi.waitFor(() => expect(replacement).toHaveLength(1));
      if (action === 'ack') await seen[0].ack();
      else if (action === 'nack') await seen[0].nack(true);
      else await first.unsubscribe();
      expect(((await redis.xpending(`${prefix}stream:tokens`, 'tokens')) as any)[0]).toBe(1);
      expect(await redis.llen(`${prefix}retry:${JSON.stringify(['tokens', 'tokens'])}`)).toBe(0);
      await replacement[0].ack();
      expect(((await redis.xpending(`${prefix}stream:tokens`, 'tokens')) as any)[0]).toBe(0);
      expect(await redis.hlen(`${prefix}delivery-tokens:${JSON.stringify(['tokens', 'tokens'])}`)).toBe(0);
      await first.unsubscribe();
      await second.unsubscribe();
    });
    it('refuses an expired delivery acknowledgment before takeover', async () => {
      const seen: Message<number>[] = [];
      const subscription = await adapter.consume('expired', 'group', 'owner', async message => { seen.push(message); }, { groupId: 'group', autoCommit: false, visibilityTimeout: 1000 });
      const id = await new StreamImpl<number>('expired', adapter).publish(1);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await subscription.pause!();
      await redis.xclaim(`${prefix}stream:expired`, 'group', 'owner', 0, id, 'IDLE', 2000);
      await seen[0].ack();
      expect(((await redis.xpending(`${prefix}stream:expired`, 'group')) as any)[0]).toBe(1);
      await subscription.unsubscribe();
    });
    it('uses Redis server time for age retention despite producer clock skew', async () => {
      const stream = new StreamImpl<number>('retention-clock', adapter);
      await stream.publish(1);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
      try {
        expect(await stream.trim({ maxAgeSeconds: 60 })).toBe(0);
        clock.mockReturnValue(0);
        expect(await stream.trim({ maxAgeSeconds: 0 })).toBe(1);
      } finally { clock.mockRestore(); await stream.close(); }
    });
    it("roundtrips full workflow checkpoints and trims retained stream data", async () => {
      const checkpoint: any = {
        id: "execution",
        workflowId: "workflow",
        status: "running",
        input: {},
        startedAt: 1,
        state: { nested: [1] },
        journal: { 0: { completed: true } },
        history: [{ type: "step.completed" }],
      };
      await adapter.saveWorkflowState("execution", checkpoint);
      expect(await adapter.loadWorkflowState("execution")).toEqual(checkpoint);
      const stream = new StreamImpl<number>("stream", adapter);
      await stream.publishBatch([1, 2, 3].map((data) => ({ data })));
      expect(await stream.trim({ maxLength: 1 })).toBe(2);
      expect(
        (await stream.getMessages("-", "+")).map((message) => message.data),
      ).toEqual([3]);
      expect(await stream.trim({ maxLength: 0 })).toBe(1);
      await stream.close();
    });
  },
);
