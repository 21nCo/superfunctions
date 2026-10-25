import { afterEach, expect, it, vi } from "vitest";
import { CronScheduler } from "./cron.js";
import { MemoryStore } from "../store/memory-store.js";
import {
  MemoryQueueClient,
  DEFAULT_QUEUE_NAME,
} from "../queue/flowfn-client.js";
const spec = {
  on: { schedule: [{ cron: "0 * * * *" }] },
  jobs: { build: { "runs-on": "default", steps: [{ run: "echo owned" }] } },
};
afterEach(() => vi.useRealTimers());
it("does not enqueue before the actual UTC cron occurrence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T11:01:00Z"));
  const store = new MemoryStore(),
    queue = new MemoryQueueClient(),
    scheduler = new CronScheduler({ store, queue });
  scheduler.register({
    id: "hourly",
    spec,
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "0 * * * *",
  });
  scheduler.start(1000);
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  } finally {
    await scheduler.stop();
  }
});
it("enqueues only due occurrences once despite duplicate start, and stop/restart skips missed time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T11:59:59Z"));
  const store = new MemoryStore(),
    queue = new MemoryQueueClient(),
    scheduler = new CronScheduler({ store, queue });
  scheduler.register({
    id: "hourly",
    spec,
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "0 * * * *",
  });
  await scheduler.start();
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(999);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
  await scheduler.stop();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(3599999);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(2);
  await scheduler.stop();
});
it("stop fences a held secret lookup before run admission and drains ownership", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T11:59:59Z"));
  let release!: (value: string) => void;
  const held = new Promise<string>((resolve) => (release = resolve));
  const store = new MemoryStore(),
    queue = new MemoryQueueClient(),
    scheduler = new CronScheduler({
      store,
      queue,
      secrets: {
        getSecret: () => held,
        setSecret: async () => {},
        listKeys: async () => [],
      },
    });
  scheduler.register({
    id: "held",
    spec: { ...spec, env: { TOKEN: "${{ secrets.TOKEN }}" } },
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "0 * * * *",
  });
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(1000);
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release("private-token");
  await stopping;
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  expect(store.listRuns().runs.length).toBe(0);
});
it("validates real calendar ranges before successful start and rejects duplicate registration", async () => {
  const scheduler = new CronScheduler({
    store: new MemoryStore(),
    queue: new MemoryQueueClient(),
  });
  const input = {
    id: "bad",
    spec,
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "99 * * * *",
  };
  scheduler.register(input);
  expect(() => scheduler.register(input)).toThrow();
  await expect(scheduler.start()).rejects.toThrow("Invalid cron");
  await scheduler.stop();
});
it("uses Flow calendar grammar, UTC and snapshot isolation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T11:59:59Z"));
  const queue = new MemoryQueueClient(),
    scheduler = new CronScheduler({ store: new MemoryStore(), queue });
  const input = {
    id: "ranges",
    spec,
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "0-30/15 12 * * 0",
  };
  scheduler.register(input);
  input.cronExpression = "0 0 * * *";
  scheduler.getRegisteredPipelines()[0].cronExpression = "0 0 * * *";
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
  await scheduler.stop();
});
it("sanitizes provider failures and advances to the next occurrence without a retry loop", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T11:59:59Z"));
  let calls = 0;
  const queue = new MemoryQueueClient(),
    scheduler = new CronScheduler({
      store: new MemoryStore(),
      queue,
      secrets: {
        getSecret: async () => {
          calls++;
          throw Error("provider-private-token");
        },
        setSecret: async () => {},
        listKeys: async () => [],
      },
    });
  scheduler.register({
    id: "failure",
    spec: { ...spec, env: { TOKEN: "${{ secrets.TOKEN }}" } },
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "0 * * * *",
  });
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toBe(1);
  expect((await scheduler.status())[0].lastError).toBe(
    "Scheduled run admission failed",
  );
  expect(JSON.stringify(await scheduler.status())).not.toContain(
    "private-token",
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls).toBe(1);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  await scheduler.stop();
});
it("a timed-out stop keeps restart fenced and late preparation cannot admit work", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T11:59:59Z"));
  let release!: (value: string) => void;
  const held = new Promise<string>((resolve) => (release = resolve));
  const queue = new MemoryQueueClient(),
    scheduler = new CronScheduler({
      store: new MemoryStore(),
      queue,
      secrets: {
        getSecret: () => held,
        setSecret: async () => {},
        listKeys: async () => [],
      },
    });
  scheduler.register({
    id: "timeout",
    spec: { ...spec, env: { TOKEN: "${{ secrets.TOKEN }}" } },
    pipelineRef: { repo: "org/repo", ref: "main" },
    cronExpression: "0 * * * *",
  });
  await scheduler.start();
  await vi.advanceTimersByTimeAsync(1000);
  const stopping = scheduler.stop({ timeout: 10 });
  const rejected = expect(stopping).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  await expect(scheduler.start()).rejects.toThrow("stopping");
  release("private-token");
  await vi.advanceTimersByTimeAsync(0);
  expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  await expect(scheduler.stop()).rejects.toThrow("timed out");
});
