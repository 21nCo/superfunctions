/**
 * Console sink tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sinkConsole } from "./console.js";
import type { LogEvent } from "../types.js";

describe("Console Sink", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createEvent = (overrides?: Partial<LogEvent>): LogEvent => ({
    ts: "2026-01-14T12:00:00.000Z",
    level: "info",
    msg: "test message",
    name: "test",
    version: "0",
    ...overrides,
  });

  describe("JSON Mode", () => {
    it("should output JSON stringified events", () => {
      const sink = sinkConsole({ json: true });
      const event = createEvent();

      sink([event]);

      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it("should route error level to stderr", () => {
      const sink = sinkConsole({ json: true });
      const event = createEvent({ level: "error" });

      sink([event]);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("should route fatal level to stderr", () => {
      const sink = sinkConsole({ json: true });
      const event = createEvent({ level: "fatal" });

      sink([event]);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("should route warn level to warn", () => {
      const sink = sinkConsole({ json: true });
      const event = createEvent({ level: "warn" });

      sink([event]);

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it("should handle batch of events", () => {
      const sink = sinkConsole({ json: true });
      const events = [
        createEvent({ level: "info" }),
        createEvent({ level: "warn" }),
        createEvent({ level: "error" }),
      ];

      sink(events);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Pretty Mode", () => {
    it("should output formatted events", () => {
      const sink = sinkConsole({ json: false, color: false });
      const event = createEvent();

      sink([event]);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(output).toContain("INFO");
      expect(output).toContain("[test]");
      expect(output).toContain("test message");
    });

    it("should include context in output", () => {
      const sink = sinkConsole({ json: false, color: false });
      const event = createEvent({
        ctx: { userId: "123", action: "login" },
      });

      sink([event]);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(output).toContain("userId");
      expect(output).toContain("123");
    });

    it("should include tags in output", () => {
      const sink = sinkConsole({ json: false, color: false });
      const event = createEvent({
        tags: ["http", "api"],
      });

      sink([event]);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(output).toContain("#http");
      expect(output).toContain("#api");
    });

    it("should include correlation IDs", () => {
      const sink = sinkConsole({ json: false, color: false });
      const event = createEvent({
        traceId: "trace123abc",
        requestId: "req456def",
      });

      sink([event]);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(output).toContain("trace=trace123");
      expect(output).toContain("req=req456de");
    });

    it("should pad log levels", () => {
      const sink = sinkConsole({ json: false, color: false });

      sink([createEvent({ level: "info" })]);
      sink([createEvent({ level: "error" })]);

      const output1 = consoleLogSpy.mock.calls[0][0] as string;
      const output2 = consoleErrorSpy.mock.calls[0][0] as string;

      expect(output1).toContain("INFO ");
      expect(output2).toContain("ERROR");
    });
  });

  describe("Color Mode", () => {
    it("should include ANSI color codes when enabled", () => {
      const sink = sinkConsole({ json: false, color: true });
      const event = createEvent({ level: "info" });

      sink([event]);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      // Should contain ANSI escape codes
      expect(output).toMatch(/\x1b\[\d+m/);
    });

    it("should not include color codes when disabled", () => {
      const sink = sinkConsole({ json: false, color: false });
      const event = createEvent({ level: "info" });

      sink([event]);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      // Should not contain ANSI escape codes
      expect(output).not.toMatch(/\x1b\[\d+m/);
    });

    it("should use custom level colors", () => {
      const sink = sinkConsole({
        json: false,
        color: true,
        levelColors: { info: "\x1b[95m" }, // Custom color
      });
      const event = createEvent({ level: "info" });

      sink([event]);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(output).toContain("\x1b[95m");
    });
  });

  describe("Synchronous Behavior", () => {
    it("should write synchronously", () => {
      const sink = sinkConsole({ json: true });
      const event = createEvent();

      expect(() => sink([event])).not.toThrow();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("should not have flush method", () => {
      const sink = sinkConsole();
      expect(sink.flush).toBeUndefined();
    });
  });
});
