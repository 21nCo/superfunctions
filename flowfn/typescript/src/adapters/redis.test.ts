import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
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
    beforeEach(() => {
      redis = new Redis(process.env.FLOWFN_REDIS_URL!);
      prefix = `flowfn-test-${randomUUID()}:`;
      adapter = new RedisAdapter({ connection: redis, prefix });
    });
    afterEach(async () => {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      await adapter.cleanup();
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
      const recovered: Message<number>[] = [];
      const second = stream.createConsumer("second", {
        groupId: "group",
        autoCommit: false,
        visibilityTimeout: 30,
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
