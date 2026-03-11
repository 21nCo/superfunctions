import { describe, expect, it } from "vitest";
import { SearchAdapterError } from "../src/types";
import { computeRetryDelayMs, runWithRetry } from "../src/internal/retry";

describe("retry utilities", () => {
  it("uses deterministic bounded delays", () => {
    const d0 = computeRetryDelayMs(0, { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 5000 });
    const d1 = computeRetryDelayMs(1, { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 5000 });
    const d2 = computeRetryDelayMs(2, { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 5000 });

    expect(d0).toBe(125);
    expect(d1).toBe(250);
    expect(d2).toBe(475);
  });

  it("retries retryable errors and succeeds within budget", async () => {
    let attempts = 0;

    const result = await runWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("ETIMEDOUT");
        }
        return "ok";
      },
      {
        policy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
        isRetryableError: (error) => String((error as Error).message).includes("ETIMEDOUT"),
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("fails with retry budget exhausted when retryable failures persist", async () => {
    let attempts = 0;

    await expect(
      runWithRetry(
        async () => {
          attempts += 1;
          throw new Error("ETIMEDOUT");
        },
        {
          policy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
          isRetryableError: (error) => String((error as Error).message).includes("ETIMEDOUT"),
          exhaustedError: new SearchAdapterError("INTERNAL", "Retry budget exhausted"),
        },
      ),
    ).rejects.toMatchObject({ code: "INTERNAL", message: "Retry budget exhausted" });

    expect(attempts).toBe(3);
  });

  it("fails fast for non-retryable errors", async () => {
    let attempts = 0;

    await expect(
      runWithRetry(
        async () => {
          attempts += 1;
          throw new Error("EINVAL");
        },
        {
          policy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
          isRetryableError: (error) => String((error as Error).message).includes("ETIMEDOUT"),
        },
      ),
    ).rejects.toThrow("EINVAL");

    expect(attempts).toBe(1);
  });
});
