import { describe, it, expect } from "vitest";
import { ConditionEvaluator } from "../../src/alerts/conditions";

describe("ConditionEvaluator", () => {
  const evaluator = new ConditionEvaluator();

  describe("threshold conditions", () => {
    it("should evaluate greater than threshold", () => {
      const condition = {
        type: "threshold" as const,
        metric: "cpu.usage",
        operator: "gt" as const,
        threshold: 80,
        window: "5m",
        aggregation: "avg" as const,
      };

      const data = [{ value: 85 }, { value: 90 }, { value: 88 }];

      const result = evaluator.evaluate(condition, data);
      expect(result).toBe(true);
    });

    it("should evaluate less than threshold", () => {
      const condition = {
        type: "threshold" as const,
        metric: "memory.free",
        operator: "lt" as const,
        threshold: 1000,
        window: "5m",
        aggregation: "avg" as const,
      };

      const data = [{ value: 500 }, { value: 600 }, { value: 550 }];

      const result = evaluator.evaluate(condition, data);
      expect(result).toBe(true);
    });
  });

  describe("anomaly detection", () => {
    it("should detect moving average anomaly", () => {
      const condition = {
        type: "anomaly" as const,
        metric: "requests.count",
        sensitivity: 0.8,
        minDataPoints: 5,
        algorithm: "moving-average" as const,
      };

      // Normal values around 100, then a spike
      const data = [
        { value: 100 },
        { value: 105 },
        { value: 98 },
        { value: 102 },
        { value: 99 },
        { value: 500 }, // Anomaly
      ];

      const result = evaluator.evaluate(condition, data);
      expect(result).toBe(true);
    });

    it("should detect standard deviation anomaly", () => {
      const condition = {
        type: "anomaly" as const,
        metric: "response.time",
        sensitivity: 0.7,
        minDataPoints: 10,
        algorithm: "stddev" as const,
      };

      // Create normally distributed data with an outlier
      const data = Array.from({ length: 15 }, (_, i) => ({
        value: i < 14 ? 100 + Math.random() * 10 : 500, // Last value is outlier
      }));

      const result = evaluator.evaluate(condition, data);
      expect(result).toBe(true);
    });
  });

  describe("composite conditions", () => {
    it("should evaluate AND conditions", () => {
      const condition = {
        type: "composite" as const,
        operator: "and" as const,
        conditions: [
          {
            type: "threshold" as const,
            metric: "cpu",
            operator: "gt" as const,
            threshold: 80,
            window: "5m",
            aggregation: "avg" as const,
          },
          {
            type: "threshold" as const,
            metric: "memory",
            operator: "gt" as const,
            threshold: 90,
            window: "5m",
            aggregation: "avg" as const,
          },
        ],
      };

      const data = [
        { value: 85 }, // CPU > 80
        { value: 95 }, // Memory > 90
      ];

      const result = evaluator.evaluate(condition, data);
      expect(result).toBe(true);
    });

    it("should evaluate OR conditions", () => {
      const condition = {
        type: "composite" as const,
        operator: "or" as const,
        conditions: [
          {
            type: "threshold" as const,
            metric: "error.rate",
            operator: "gt" as const,
            threshold: 5,
            window: "5m",
            aggregation: "avg" as const,
          },
          {
            type: "threshold" as const,
            metric: "latency",
            operator: "gt" as const,
            threshold: 1000,
            window: "5m",
            aggregation: "avg" as const,
          },
        ],
      };

      const data = [
        { value: 3 }, // Error rate < 5
        { value: 1500 }, // Latency > 1000
      ];

      const result = evaluator.evaluate(condition, data);
      expect(result).toBe(true); // True because one condition is met
    });
  });
});
