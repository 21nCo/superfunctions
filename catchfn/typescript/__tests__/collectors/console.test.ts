/**
 * ConsoleCollector tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConsoleCollector } from "../../src/collectors/console.js";

describe("ConsoleCollector", () => {
  let collector: ConsoleCollector;
  const originalConsole = { ...console };

  beforeEach(() => {
    collector = new ConsoleCollector(10);
  });

  afterEach(() => {
    collector.stop();
    // Restore console
    Object.assign(console, originalConsole);
  });

  describe("start/stop", () => {
    it("should intercept console methods when started", () => {
      collector.start();

      console.log("Test log");
      console.warn("Test warning");
      console.error("Test error");

      const logs = collector.collect();
      expect(logs).toHaveLength(3);
      expect(logs[0].level).toBe("log");
      expect(logs[1].level).toBe("warn");
      expect(logs[2].level).toBe("error");
    });

    it("should not intercept when stopped", () => {
      collector.start();
      console.log("Message 1");

      collector.stop();
      console.log("Message 2");

      const logs = collector.collect();
      expect(logs).toHaveLength(1);
      expect(logs[0].args[0]).toBe("Message 1");
    });

    it("should not double-start", () => {
      collector.start();
      collector.start();

      console.log("Test");

      const logs = collector.collect();
      expect(logs).toHaveLength(1);
    });
  });

  describe("capture", () => {
    beforeEach(() => {
      collector.start();
    });

    it("should capture string arguments", () => {
      console.log("Hello", "World");

      const logs = collector.collect();
      expect(logs[0].args).toEqual(["Hello", "World"]);
    });

    it("should capture number arguments", () => {
      console.log(42, 3.14);

      const logs = collector.collect();
      expect(logs[0].args).toEqual([42, 3.14]);
    });

    it("should capture boolean arguments", () => {
      console.log(true, false);

      const logs = collector.collect();
      expect(logs[0].args).toEqual([true, false]);
    });

    it("should serialize Error objects", () => {
      const error = new Error("Test error");
      console.error(error);

      const logs = collector.collect();
      expect(logs[0].args[0]).toHaveProperty("name", "Error");
      expect(logs[0].args[0]).toHaveProperty("message", "Test error");
      expect(logs[0].args[0]).toHaveProperty("stack");
    });

    it("should serialize objects", () => {
      console.log({ foo: "bar", num: 123 });

      const logs = collector.collect();
      expect(logs[0].args[0]).toEqual({ foo: "bar", num: 123 });
    });

    it("should handle circular references", () => {
      const obj: any = { name: "test" };
      obj.self = obj;

      console.log(obj);

      const logs = collector.collect();
      // Should not throw, serializes to string
      expect(logs[0].args[0]).toBeDefined();
    });
  });

  describe("buffer", () => {
    beforeEach(() => {
      collector.start();
    });

    it("should maintain size limit", () => {
      // Add 15 logs to a collector with max 10
      for (let i = 0; i < 15; i++) {
        console.log(`Message ${i}`);
      }

      const logs = collector.collect();
      expect(logs).toHaveLength(10);
      // Should keep the last 10
      expect(logs[0].args[0]).toBe("Message 5");
      expect(logs[9].args[0]).toBe("Message 14");
    });
  });

  describe("clear", () => {
    it("should clear all logs", () => {
      collector.start();
      console.log("Test 1");
      console.log("Test 2");

      expect(collector.size()).toBe(2);

      collector.clear();

      expect(collector.size()).toBe(0);
      expect(collector.collect()).toEqual([]);
    });
  });

  describe("size", () => {
    it("should return current log count", () => {
      collector.start();

      expect(collector.size()).toBe(0);

      console.log("Test 1");
      expect(collector.size()).toBe(1);

      console.log("Test 2");
      expect(collector.size()).toBe(2);
    });
  });
});
