import { describe, it, expect, beforeEach } from "vitest";
import { MetricAggregator, MetricPoint } from "../../src/core/metric-aggregator";

describe("MetricAggregator", () => {
  let aggregator: MetricAggregator;

  beforeEach(() => {
    aggregator = new MetricAggregator({
      intervals: ["1m", "5m"],
      maxDataPoints: 1000,
    });
  });

  describe("add", () => {
    it("should add a metric point", () => {
      const point: MetricPoint = {
        timestamp: Date.now(),
        value: 100,
      };

      aggregator.add("test.metric", point);
      const result = aggregator.get(
        "test.metric",
        "1m",
        point.timestamp - 1000,
        point.timestamp + 1000
      );

      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle multiple data points", () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        aggregator.add("test.metric", {
          timestamp: now + i * 1000,
          value: i * 10,
        });
      }

      const result = aggregator.get(
        "test.metric",
        "1m",
        now - 1000,
        now + 11000
      );
      expect(result.length).toBeGreaterThan(0);
    });

    it("should aggregate with correct functions", () => {
      const now = Date.now();
      const values = [10, 20, 30, 40, 50];

      values.forEach((value, i) => {
        aggregator.add("test.metric", {
          timestamp: now + i * 1000,
          value,
        });
      });

      const avgResults = aggregator.get(
        "test.metric",
        "1m",
        now - 1000,
        now + 6000,
        "avg"
      );
      expect(avgResults.length).toBeGreaterThan(0);

      // Average should be 30
      const avgValue = avgResults[0]?.value;
      expect(avgValue).toBeCloseTo(30, 0);
    });
  });

  describe("percentiles", () => {
    it("should calculate p95 correctly", () => {
      const now = Date.now();

      // Add 100 values
      for (let i = 1; i <= 100; i++) {
        aggregator.add("test.metric", {
          timestamp: now + i * 100,
          value: i,
        });
      }

      const p95Results = aggregator.get(
        "test.metric",
        "1m",
        now,
        now + 11000,
        "p95"
      );
      expect(p95Results.length).toBeGreaterThan(0);

      const p95Value = p95Results[0]?.value;
      expect(p95Value).toBeGreaterThan(90);
      expect(p95Value).toBeLessThanOrEqual(100);
    });
  });

  describe("rolling windows", () => {
    it("should maintain rolling window size", () => {
      const aggregator = new MetricAggregator({
        intervals: ["1m"],
        maxDataPoints: 10,
      });

      const now = Date.now();

      // Add 20 points (more than max)
      for (let i = 0; i < 20; i++) {
        aggregator.add("test.metric", {
          timestamp: now + i * 1000,
          value: i,
        });
      }

      // Should have pruned old data
      const stats = aggregator.getStats();
      expect(stats.dataPoints).toBeLessThanOrEqual(10);
    });
  });

  describe("pruning", () => {
    it("should prune old aggregations", () => {
      const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago

      aggregator.add("test.metric", {
        timestamp: oldTimestamp,
        value: 100,
      });

      // Prune data older than 5 minutes
      aggregator.prune(5 * 60 * 1000);

      const result = aggregator.get(
        "test.metric",
        "1m",
        oldTimestamp - 1000,
        oldTimestamp + 1000
      );
      expect(result.length).toBe(0);
    });
  });
});
