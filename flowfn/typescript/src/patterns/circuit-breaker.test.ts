import { describe, it, expect, vi } from "vitest";
import { circuitBreaker } from "./circuit-breaker.js";

describe("Circuit Breaker", () => {
  it("should open after threshold is reached", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      throw new Error("fail");
    };

    const cb = circuitBreaker({ threshold: 2, timeout: 1000 }, handler);

    // First failure
    await expect(cb({} as any)).rejects.toThrow("fail");
    expect(calls).toBe(1);

    // Second failure -> Should open
    await expect(cb({} as any)).rejects.toThrow("fail");
    expect(calls).toBe(2);

    // Third call -> Should be rejected immediately without calling handler
    await expect(cb({} as any)).rejects.toThrow("Circuit Breaker is OPEN");
    expect(calls).toBe(2);
  });

  it("should transition to half-open after timeout", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const handler = async () => {
      calls++;
      if (calls > 2) return "success";
      throw new Error("fail");
    };

    const cb = circuitBreaker({ threshold: 2, timeout: 1000 }, handler);

    await expect(cb({} as any)).rejects.toThrow("fail");
    await expect(cb({} as any)).rejects.toThrow("fail");
    await expect(cb({} as any)).rejects.toThrow("Circuit Breaker is OPEN");

    // Fast forward
    await vi.advanceTimersByTimeAsync(1001);

    // Should call handler again (half-open)
    const result = await cb({} as any);
    expect(result).toBe("success");
    expect(calls).toBe(3);

    vi.useRealTimers();
  });
});
