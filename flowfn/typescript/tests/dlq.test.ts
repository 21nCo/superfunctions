/**
 * Tests for Dead Letter Queue (DLQ)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryDLQManager, DLQJob } from "../src/queue/dlq.js";
import { Job } from "../src/queue/types.js";

describe("DLQ Manager", () => {
  let dlq: MemoryDLQManager;

  beforeEach(() => {
    dlq = new MemoryDLQManager({
      maxRetries: 3,
      queueName: "test-dlq",
    });
  });

  it("should move job to DLQ", async () => {
    const job: Partial<Job> = {
      id: "job-1",
      name: "test-job",
      data: { foo: "bar" },
      state: "failed",
      failedReason: "Test failure",
      attemptsMade: 3,
    } as Job;

    const dlqJob = await dlq.moveToDLQ(job as Job, "Max retries exceeded");

    expect(dlqJob.id).toBe("job-1");
    expect(dlqJob.originalQueue).toBe("test-job");
    expect(dlqJob.dlqReason).toBe("Max retries exceeded");
    expect(dlqJob.dlqTimestamp).toBeGreaterThan(0);
  });

  it("should get all DLQ jobs", async () => {
    const job1: Partial<Job> = {
      id: "job-1",
      name: "queue-1",
      data: {},
      state: "failed",
    } as Job;

    const job2: Partial<Job> = {
      id: "job-2",
      name: "queue-2",
      data: {},
      state: "failed",
    } as Job;

    await dlq.moveToDLQ(job1 as Job, "reason1");
    await dlq.moveToDLQ(job2 as Job, "reason2");

    const all = await dlq.getAll();
    expect(all).toHaveLength(2);
  });

  it("should get jobs by queue", async () => {
    const job1: Partial<Job> = {
      id: "job-1",
      name: "queue-1",
      data: {},
      state: "failed",
    } as Job;

    const job2: Partial<Job> = {
      id: "job-2",
      name: "queue-2",
      data: {},
      state: "failed",
    } as Job;

    await dlq.moveToDLQ(job1 as Job, "reason");
    await dlq.moveToDLQ(job2 as Job, "reason");

    const queue1Jobs = await dlq.getByQueue("queue-1");
    expect(queue1Jobs).toHaveLength(1);
    expect(queue1Jobs[0].id).toBe("job-1");
  });

  it("should retry DLQ job", async () => {
    const job: Partial<Job> = {
      id: "job-1",
      name: "test-queue",
      data: { value: 123 },
      state: "failed",
      attemptsMade: 3,
    } as Job;

    await dlq.moveToDLQ(job as Job, "Test failure");

    const retriedJob = await dlq.retry("job-1");

    expect(retriedJob.state).toBe("waiting");
    expect(retriedJob.attemptsMade).toBe(0);
    expect(retriedJob.failedReason).toBeUndefined();

    // Should be removed from DLQ
    const remaining = await dlq.getAll();
    expect(remaining).toHaveLength(0);
  });

  it("should retry all jobs from a queue", async () => {
    const job1: Partial<Job> = {
      id: "job-1",
      name: "queue-1",
      data: {},
      state: "failed",
    } as Job;

    const job2: Partial<Job> = {
      id: "job-2",
      name: "queue-1",
      data: {},
      state: "failed",
    } as Job;

    await dlq.moveToDLQ(job1 as Job, "reason");
    await dlq.moveToDLQ(job2 as Job, "reason");

    const count = await dlq.retryAll("queue-1");
    expect(count).toBe(2);

    const remaining = await dlq.getAll();
    expect(remaining).toHaveLength(0);
  });

  it("should clean expired jobs", async () => {
    const job: Partial<Job> = {
      id: "job-1",
      name: "test-queue",
      data: {},
      state: "failed",
    } as Job;

    await dlq.moveToDLQ(job as Job, "reason");

    // Clean jobs older than 0ms (should clean all)
    const count = await dlq.clean(0);
    expect(count).toBe(1);

    const remaining = await dlq.getAll();
    expect(remaining).toHaveLength(0);
  });

  it("should get stats", async () => {
    const job1: Partial<Job> = {
      id: "job-1",
      name: "queue-1",
      data: {},
      state: "failed",
    } as Job;

    const job2: Partial<Job> = {
      id: "job-2",
      name: "queue-2",
      data: {},
      state: "failed",
    } as Job;

    const job3: Partial<Job> = {
      id: "job-3",
      name: "queue-1",
      data: {},
      state: "failed",
    } as Job;

    await dlq.moveToDLQ(job1 as Job, "reason");
    await dlq.moveToDLQ(job2 as Job, "reason");
    await dlq.moveToDLQ(job3 as Job, "reason");

    const stats = await dlq.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byQueue["queue-1"]).toBe(2);
    expect(stats.byQueue["queue-2"]).toBe(1);
  });

  it("should call onDLQ callback", async () => {
    let callbackCalled = false;
    let callbackJob: Job | null = null;
    let callbackReason = "";

    const dlqWithCallback = new MemoryDLQManager({
      onDLQ: (job, reason) => {
        callbackCalled = true;
        callbackJob = job;
        callbackReason = reason;
      },
    });

    const job: Partial<Job> = {
      id: "job-1",
      name: "test-queue",
      data: {},
      state: "failed",
    } as Job;

    await dlqWithCallback.moveToDLQ(job as Job, "Test reason");

    expect(callbackCalled).toBe(true);
    expect((callbackJob as Job | null)?.id).toBe("job-1");
    expect(callbackReason).toBe("Test reason");
  });
});

it("expires DLQ jobs at the exact retention boundary while preserving younger jobs", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const manager = new MemoryDLQManager();
    await manager.moveToDLQ({ id: "old", name: "queue", data: {}, state: "failed" } as Job, "failure");
    clock.mockReturnValue(1050);
    await manager.moveToDLQ({ id: "young", name: "queue", data: {}, state: "failed" } as Job, "failure");
    clock.mockReturnValue(1100);
    expect(await manager.clean(100)).toBe(1);
    expect((await manager.getAll()).map(job => job.id)).toEqual(["young"]);
    expect(await manager.clean(0)).toBe(1);
    await expect(manager.clean(-1)).rejects.toThrow("nonnegative");
  } finally { clock.mockRestore(); }
});
