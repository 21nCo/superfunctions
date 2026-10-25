import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFlow } from "../core/flow-fn.js";

describe("Retry & Backoff", () => {
  let flow: ReturnType<typeof createFlow>;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  afterEach(async () => {
    await flow.close();
  });

  it("should retry a failed job with backoff", async () => {
    const queue = flow.queue("retry-test");
    let attempts = 0;

    await queue.add(
      "test-job",
      { foo: "bar" },
      {
        attempts: 3,
        backoff: { type: "fixed", delay: 10 },
      },
    );

    await new Promise<void>((resolve) => {
      queue.process(async (job) => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Transient failure");
        }
        resolve();
      });
    });

    expect(attempts).toBe(3);
  });

  it("should move to failed after max attempts", async () => {
    const queue = flow.queue("fail-test");
    let attempts = 0;

    await queue.add(
      "test-job",
      { foo: "bar" },
      {
        attempts: 2,
        backoff: { type: "fixed", delay: 10 },
      },
    );

    const failedPromise = new Promise<void>((resolve) => {
      queue.on("failed", (job) => {
        if (job.attemptsMade === 2) {
          resolve();
        }
      });
    });

    queue.process(async (job) => {
      attempts++;
      throw new Error("Permanent failure");
    });

    await failedPromise;
    expect(attempts).toBe(2);
  });
});
