import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Scheduler } from "./scheduler.js";

describe("Scheduler", () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await scheduler.close();
    vi.useRealTimers();
  });

  it("should schedule a task using cron pattern", async () => {
    let count = 0;
    // Every second
    await scheduler.schedule("test", "* * * * * *", async () => {
      count++;
    });

    const list = await scheduler.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("test");

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(2);
  });

  it('should schedule a task using "every" interval', async () => {
    let count = 0;
    await scheduler.schedule("repeat", { every: 100 }, async () => {
      count++;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(count).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(count).toBe(2);
  });

  it("should respect limits", async () => {
    let count = 0;
    await scheduler.schedule("limited", { every: 100, limit: 2 }, async () => {
      count++;
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(count).toBe(2);
    const list = await scheduler.list();
    expect(list).toHaveLength(0);
  });

  it("should pause and resume", async () => {
    let count = 0;
    await scheduler.schedule("pause-test", { every: 100 }, async () => {
      count++;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(count).toBe(1);

    await scheduler.pause("pause-test");
    await vi.advanceTimersByTimeAsync(100);
    expect(count).toBe(1);

    await scheduler.resume("pause-test");
    await vi.advanceTimersByTimeAsync(100);
    expect(count).toBe(2);
  });
  it("backs off failed callbacks to the next scheduled interval and counts attempts", async () => {
    const handler = vi.fn(async () => {
      throw new Error("offline");
    });
    await scheduler.schedule("fail", { every: 100, limit: 2 }, handler);
    await vi.advanceTimersByTimeAsync(199);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await scheduler.list())[0]).toMatchObject({
      count: 1,
      lastError: "offline",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await scheduler.list()).toEqual([]);
  });
  it("validates schedules before replacing an existing task and honors zero and end limits", async () => {
    await scheduler.schedule("valid", { every: 100 }, async () => {});
    await expect(
      scheduler.schedule("valid", { every: 0 }, async () => {}),
    ).rejects.toThrow("positive");
    expect(await scheduler.list()).toHaveLength(1);
    await scheduler.schedule("zero", { every: 100, limit: 0 }, async () => {});
    await scheduler.schedule(
      "ended",
      { every: 100, endDate: new Date(Date.now() - 1) },
      async () => {},
    );
    expect(await scheduler.list()).toHaveLength(1);
  });
  it("does not let a cancelled in-flight callback replace a newly scheduled task", async () => {
    let release!: () => void;
    await scheduler.schedule(
      "replace",
      { every: 10 },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(10);
    const replacement = vi.fn();
    await scheduler.schedule("replace", { every: 100, limit: 1 }, replacement);
    release();
    await vi.advanceTimersByTimeAsync(99);
    expect(replacement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
