/**
 * Tests for Health Monitoring
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HealthCheckerImpl,
  MemoryEventTracker,
} from "../src/monitoring/health.js";

describe("Health Checker", () => {
  let healthChecker: HealthCheckerImpl;

  beforeEach(() => {
    healthChecker = new HealthCheckerImpl();
  });

  it("should perform default health checks", async () => {
    const health = await healthChecker.check();

    expect(health.healthy).toBe(true);
    expect(health.timestamp).toBeGreaterThan(0);
    expect(health.checks.length).toBeGreaterThan(0);

    // Should have uptime and memory checks
    const checkNames = health.checks.map((c) => c.name);
    expect(checkNames).toContain("uptime");
    expect(checkNames).toContain("memory");
  });

  it("should add custom health check", async () => {
    healthChecker.addCheck("custom", async () => ({
      name: "custom",
      status: "pass",
      message: "Custom check passed",
    }));

    const health = await healthChecker.check();
    const customCheck = health.checks.find((c) => c.name === "custom");

    expect(customCheck).toBeDefined();
    expect(customCheck?.status).toBe("pass");
    expect(customCheck?.message).toBe("Custom check passed");
  });

  it("should handle failing health checks", async () => {
    healthChecker.addCheck("failing", async () => ({
      name: "failing",
      status: "fail",
      message: "This check failed",
    }));

    const health = await healthChecker.check();

    expect(health.healthy).toBe(false);
    const failingCheck = health.checks.find((c) => c.name === "failing");
    expect(failingCheck?.status).toBe("fail");
  });

  it("should remove health check", async () => {
    healthChecker.addCheck("temp", async () => ({
      name: "temp",
      status: "pass",
    }));

    let health = await healthChecker.check();
    expect(health.checks.some((c) => c.name === "temp")).toBe(true);

    healthChecker.removeCheck("temp");

    health = await healthChecker.check();
    expect(health.checks.some((c) => c.name === "temp")).toBe(false);
  });

  it("should track response time", async () => {
    healthChecker.addCheck("slow", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        name: "slow",
        status: "pass",
      };
    });

    const health = await healthChecker.check();
    const slowCheck = health.checks.find((c) => c.name === "slow");

    expect(slowCheck?.responseTime).toBeGreaterThan(0);
  });

  it("should handle check errors", async () => {
    healthChecker.addCheck("error", async () => {
      throw new Error("Check error");
    });

    const health = await healthChecker.check();

    expect(health.healthy).toBe(false);
    const errorCheck = health.checks.find((c) => c.name === "error");
    expect(errorCheck?.status).toBe("fail");
    expect(errorCheck?.message).toBe("Check error");
  });
});

describe("Event Tracker", () => {
  let tracker: MemoryEventTracker;

  beforeEach(() => {
    tracker = new MemoryEventTracker();
  });

  it("should track events", () => {
    tracker.track({
      type: "test.event",
      category: "system",
      severity: "info",
      message: "Test event",
    });

    const events = tracker.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("test.event");
    expect(events[0].id).toBeDefined();
    expect(events[0].timestamp).toBeGreaterThan(0);
  });

  it("should filter by category", () => {
    tracker.track({
      type: "queue.event",
      category: "queue",
      severity: "info",
      message: "Queue event",
    });

    tracker.track({
      type: "stream.event",
      category: "stream",
      severity: "info",
      message: "Stream event",
    });

    const queueEvents = tracker.getEvents({ category: "queue" });
    expect(queueEvents).toHaveLength(1);
    expect(queueEvents[0].category).toBe("queue");
  });

  it("should filter by severity", () => {
    tracker.track({
      type: "info.event",
      category: "system",
      severity: "info",
      message: "Info",
    });

    tracker.track({
      type: "error.event",
      category: "system",
      severity: "error",
      message: "Error",
    });

    const errors = tracker.getEvents({ severity: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });

  it("should filter by timestamp", () => {
    const now = Date.now();

    tracker.track({
      type: "event1",
      category: "system",
      severity: "info",
      message: "Event 1",
    });

    const events = tracker.getEvents({ since: now });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].timestamp).toBeGreaterThanOrEqual(now);
  });

  it("should limit results", () => {
    for (let i = 0; i < 10; i++) {
      tracker.track({
        type: `event${i}`,
        category: "system",
        severity: "info",
        message: `Event ${i}`,
      });
    }

    const limited = tracker.getEvents({ limit: 5 });
    expect(limited).toHaveLength(5);
  });

  it("should cleanup old events", () => {
    tracker.track({
      type: "old.event",
      category: "system",
      severity: "info",
      message: "Old event",
    });

    const cleaned = tracker.cleanup(0); // Clean all
    expect(cleaned).toBeGreaterThan(0);

    const remaining = tracker.getEvents();
    expect(remaining).toHaveLength(0);
  });

  it("should track metadata", () => {
    tracker.track({
      type: "meta.event",
      category: "system",
      severity: "info",
      message: "Event with metadata",
      metadata: {
        key: "value",
        count: 42,
      },
    });

    const events = tracker.getEvents();
    expect(events[0].metadata).toEqual({
      key: "value",
      count: 42,
    });
  });
});

it("expires tracked events at the boundary, including zero-age events", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const tracker = new MemoryEventTracker();
    tracker.track({ type: "old", category: "system", severity: "info", message: "old" });
    clock.mockReturnValue(1050);
    tracker.track({ type: "young", category: "system", severity: "info", message: "young" });
    clock.mockReturnValue(1100);
    expect(tracker.cleanup(100)).toBe(1);
    expect(tracker.getEvents().map(event => event.type)).toEqual(["young"]);
    tracker.track({ type: "now", category: "system", severity: "info", message: "now" });
    expect(tracker.cleanup(0)).toBe(2);
    expect(() => tracker.cleanup(NaN)).toThrow("nonnegative");
  } finally { clock.mockRestore(); }
});

it("filters tracked event types and isolates stored event metadata", () => {
  const tracker = new MemoryEventTracker();
  const metadata = { value: 1 };
  tracker.track({ type: "first", category: "system", severity: "info", message: "first", metadata });
  tracker.track({ type: "second", category: "system", severity: "info", message: "second" });
  metadata.value = 2;
  const selected = tracker.getEvents({ type: "first" });
  expect(selected).toHaveLength(1); expect(selected[0].metadata).toEqual({ value: 1 });
  selected[0].metadata!.value = 3;
  expect(tracker.getEvents({ type: "first" })[0].metadata).toEqual({ value: 1 });
  expect(tracker.getEvents({ limit: 0 })).toEqual([]);
});
