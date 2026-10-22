/**
 * Core Logger tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "./logger.js";
import type { LogEvent, Sink } from "../types.js";

describe("Logger", () => {
  let capturedEvents: LogEvent[] = [];
  let mockSink: Sink;

  beforeEach(() => {
    capturedEvents = [];
    mockSink = (batch: LogEvent[]) => {
      capturedEvents.push(...batch);
    };
  });

  describe("Constructor", () => {
    it("should create a logger with required options", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      expect(logger).toBeInstanceOf(Logger);
    });

    it("should throw if no sinks provided", () => {
      expect(() => {
        new Logger({
          name: "test",
          sinks: [],
        });
      }).toThrow("At least one sink is required");
    });

    it("should use default level based on environment", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.debug("test");
      expect(capturedEvents).toHaveLength(1);
    });
  });

  describe("Log Levels", () => {
    it("should log at trace level", () => {
      const logger = new Logger({
        name: "test",
        level: "trace",
        sinks: [mockSink],
      });

      logger.trace("trace message");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("trace");
      expect(capturedEvents[0].msg).toBe("trace message");
    });

    it("should log at debug level", () => {
      const logger = new Logger({
        name: "test",
        level: "debug",
        sinks: [mockSink],
      });

      logger.debug("debug message");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("debug");
    });

    it("should log at info level", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.info("info message");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("info");
    });

    it("should log at warn level", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.warn("warn message");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("warn");
    });

    it("should log at error level", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.error("error message");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("error");
    });

    it("should log at fatal level", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.fatal("fatal message");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("fatal");
    });

    it("should respect log level threshold", () => {
      const logger = new Logger({
        name: "test",
        level: "warn",
        sinks: [mockSink],
      });

      logger.trace("trace");
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");

      expect(capturedEvents).toHaveLength(2);
      expect(capturedEvents[0].level).toBe("warn");
      expect(capturedEvents[1].level).toBe("error");
    });
  });

  describe("Context and Tags", () => {
    it("should include context in events", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.info("test", { userId: "123", action: "login" });

      expect(capturedEvents[0].ctx).toEqual({
        userId: "[redacted]",
        action: "login",
      });
    });

    it("should include tags in events", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.info("test", undefined, ["http", "api"]);

      expect(capturedEvents[0].tags).toEqual(["http", "api"]);
    });

    it("should merge base context", () => {
      const logger = new Logger({
        name: "test",
        baseContext: { service: "auth" },
        sinks: [mockSink],
      });

      logger.info("test", { action: "login" });

      expect(capturedEvents[0].ctx).toEqual({
        service: "auth",
        action: "login",
      });
    });

    it("should merge base tags", () => {
      const logger = new Logger({
        name: "test",
        baseTags: ["service"],
        sinks: [mockSink],
      });

      logger.info("test", undefined, ["event"]);

      expect(capturedEvents[0].tags).toEqual(["service", "event"]);
    });
  });

  describe("Child Logger", () => {
    it("should create child logger with inherited context", () => {
      const parent = new Logger({
        name: "parent",
        baseContext: { service: "api" },
        sinks: [mockSink],
      });

      const child = parent.child({ ctx: { request: "req-123" } });

      child.info("test");

      expect(capturedEvents[0].ctx).toEqual({
        service: "api",
        request: "req-123",
      });
    });

    it("should create child logger with inherited tags", () => {
      const parent = new Logger({
        name: "parent",
        baseTags: ["service"],
        sinks: [mockSink],
      });

      const child = parent.child({ tags: ["request"] });

      child.info("test");

      expect(capturedEvents[0].tags).toEqual(["service", "request"]);
    });

    it("should allow child to override name", () => {
      const parent = new Logger({
        name: "parent",
        sinks: [mockSink],
      });

      const child = parent.child({ name: "child" });

      child.info("test");

      expect(capturedEvents[0].name).toBe("child");
    });

    it("should allow child to override level", () => {
      const parent = new Logger({
        name: "parent",
        level: "error",
        sinks: [mockSink],
      });

      const child = parent.child({ level: "debug" });

      child.debug("test");

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].level).toBe("debug");
    });
  });

  describe("Pipeline Execution", () => {
    it("should apply pipeline stages in order", () => {
      const stage1 = vi.fn((event: LogEvent) => ({
        ...event,
        ctx: { ...event.ctx, stage1: true },
      }));
      const stage2 = vi.fn((event: LogEvent) => ({
        ...event,
        ctx: { ...event.ctx, stage2: true },
      }));

      const logger = new Logger({
        name: "test",
        pipeline: [stage1, stage2],
        sinks: [mockSink],
      });

      logger.info("test");

      expect(stage1).toHaveBeenCalled();
      expect(stage2).toHaveBeenCalled();
      expect(capturedEvents[0].ctx).toEqual({
        stage1: true,
        stage2: true,
      });
    });

    it("should drop events when stage returns null", () => {
      const logger = new Logger({
        name: "test",
        pipeline: [() => null],
        sinks: [mockSink],
      });

      logger.info("test");

      expect(capturedEvents).toHaveLength(0);
    });

    it("should continue on pipeline errors", () => {
      const errorStage = () => {
        throw new Error("Pipeline error");
      };
      const validStage = (event: LogEvent) => event;

      const logger = new Logger({
        name: "test",
        pipeline: [errorStage, validStage],
        sinks: [mockSink],
      });

      logger.info("test");

      expect(capturedEvents).toHaveLength(1);
    });
  });

  describe("Flush", () => {
    it("should flush all sinks", async () => {
      const flushSpy = vi.fn();
      const sinkWithFlush: Sink = (batch) => {
        capturedEvents.push(...batch);
      };
      sinkWithFlush.flush = flushSpy;

      const logger = new Logger({
        name: "test",
        sinks: [sinkWithFlush],
      });

      await logger.flush();

      expect(flushSpy).toHaveBeenCalled();
    });

    it("should handle async flush", async () => {
      const asyncFlush = vi.fn().mockResolvedValue(undefined);
      const sinkWithFlush: Sink = (batch) => {
        capturedEvents.push(...batch);
      };
      sinkWithFlush.flush = asyncFlush;

      const logger = new Logger({
        name: "test",
        sinks: [sinkWithFlush],
      });

      await logger.flush();

      expect(asyncFlush).toHaveBeenCalled();
    });
  });

  describe("Event Schema", () => {
    it("should include required fields", () => {
      const logger = new Logger({
        name: "test-logger",
        sinks: [mockSink],
      });

      logger.info("test message");

      const event = capturedEvents[0];
      expect(event.ts).toBeDefined();
      expect(event.level).toBe("info");
      expect(event.msg).toBe("test message");
      expect(event.name).toBe("test-logger");
      expect(event.version).toBe("0");
    });

    it("should generate ISO8601 timestamps", () => {
      const logger = new Logger({
        name: "test",
        sinks: [mockSink],
      });

      logger.info("test");

      const event = capturedEvents[0];
      const date = new Date(event.ts);
      expect(date.toISOString()).toBe(event.ts);
    });

    it("should use custom timestamp function", () => {
      const fixedDate = new Date("2026-01-14T12:00:00.000Z");
      const logger = new Logger({
        name: "test",
        now: () => fixedDate,
        sinks: [mockSink],
      });

      logger.info("test");

      expect(capturedEvents[0].ts).toBe("2026-01-14T12:00:00.000Z");
    });
  });

  describe("Multiple Sinks", () => {
    it("should send events to all sinks", () => {
      const events1: LogEvent[] = [];
      const events2: LogEvent[] = [];
      const sink1: Sink = (batch) => events1.push(...batch);
      const sink2: Sink = (batch) => events2.push(...batch);

      const logger = new Logger({
        name: "test",
        sinks: [sink1, sink2],
      });

      logger.info("test");

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0].msg).toBe("test");
      expect(events2[0].msg).toBe("test");
    });

    it("should continue on sink errors", () => {
      const errorSink: Sink = () => {
        throw new Error("Sink error");
      };
      const validSink: Sink = (batch) => capturedEvents.push(...batch);

      const logger = new Logger({
        name: "test",
        sinks: [errorSink, validSink],
      });

      logger.info("test");

      expect(capturedEvents).toHaveLength(1);
    });
  });
});
