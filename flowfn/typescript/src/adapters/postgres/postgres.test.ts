import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PostgresAdapter } from "./index.js";
import { JobImpl } from "../../queue/job.js";
import { QueueImpl } from "../../queue/queue.js";
import { StreamImpl } from "../../stream/stream.js";
import type { Message } from "../../stream/types.js";
import { WorkflowBuilderImpl } from "../../workflow/workflow.js";

describe.skipIf(!process.env.FLOWFN_POSTGRES_URL)(
  "PostgreSQL native contract (requires FLOWFN_POSTGRES_URL)",
  () => {
    let pool: Pool, adapter: PostgresAdapter, schema: string;
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
      const claimed = await Promise.all(
        Array.from({ length: 30 }, () => adapter.dequeue("queue")),
      );
      expect(claimed.filter(Boolean)).toHaveLength(20);
      expect(new Set(claimed.filter(Boolean).map((job) => job!.id)).size).toBe(
        20,
      );
      expect((await adapter.getJob("other", "0"))!.data).toEqual({
        secret: true,
      });
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
    it("roundtrips workflow journals and resumes a persisted wait without repeating completed effects", async () => {
      let calls = 0;
      const build = (storage: PostgresAdapter) =>
        new WorkflowBuilderImpl("workflow", storage)
          .step("effect", async (ctx) => {
            calls++;
            ctx.set("value", 5);
          })
          .waitForEvent("go")
          .step("finish", async (ctx, value) => ctx.get("value") + value)
          .build();
      const workflow = build(adapter),
        execution = await workflow.execute({});
      await vi.waitFor(async () =>
        expect((await workflow.getExecution(execution.id)).waiting?.kind).toBe(
          "event",
        ),
      );
      const saved = await adapter.loadWorkflowState(execution.id);
      await workflow.close();
      await adapter.saveWorkflowState(execution.id, saved!);
      const reopened = new PostgresAdapter({
          db: drizzle(pool),
          schema,
          pollInterval: 10,
        }),
        restored = build(reopened);
      await restored.resumeExecution(execution.id);
      await restored.signalEvent(execution.id, "go", 7);
      expect((await restored.waitForCompletion(execution.id)).output).toBe(12);
      expect(calls).toBe(1);
      await restored.close();
      await reopened.cleanup();
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
      const b = stream.createConsumer("b", {
        groupId: "group",
        autoCommit: false,
        visibilityTimeout: 30,
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
    it("migrates legacy data transactionally while retaining original tables as backups", async () => {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE; CREATE SCHEMA "${schema}";
  CREATE TABLE "${schema}".flowfn_jobs(id text PRIMARY KEY,queue text,name text,state text,data jsonb,opts jsonb,timestamp bigint,delay bigint,attempts_made integer,progress integer,return_value jsonb,processed_on bigint,finished_on bigint,failed_reason text,stacktrace jsonb);
  INSERT INTO "${schema}".flowfn_jobs VALUES ('legacy-job','queue','task','completed','{"input":1}','{}',100,0,1,100,'42',110,120,NULL,'[]');
  CREATE TABLE "${schema}".flowfn_messages(id text PRIMARY KEY,stream text,data jsonb,headers jsonb,timestamp bigint,partition integer,key text);
  INSERT INTO "${schema}".flowfn_messages VALUES ('legacy-message','stream','{"message":1}','{}',100,NULL,NULL);`);
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
      expect(
        (await pool.query(`SELECT data FROM "${schema}".flowfn_jobs_legacy_v0`))
          .rows[0].data,
      ).toEqual({ input: 1 });
      await adapter.migrateLegacySchema();
      expect(await adapter.getAllJobs("queue")).toHaveLength(1);
    });
  },
);
