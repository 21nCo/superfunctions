/**
 * HTTP sink tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sinkHttp } from "./http.js";
import type { LogEvent } from "../types.js";

describe("HTTP Sink", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createEvent = (overrides?: Partial<LogEvent>): LogEvent => ({
    ts: "2026-01-14T12:00:00.000Z",
    level: "info",
    msg: "test message",
    name: "test",
    version: "0",
    ...overrides,
  });

  describe("Batching", () => {
    it("should batch events until batch size reached", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 3,
      });

      sink([createEvent({ msg: "1" })]);
      sink([createEvent({ msg: "2" })]);

      // Should not send yet
      expect(fetchMock).not.toHaveBeenCalled();

      sink([createEvent({ msg: "3" })]);

      // Should trigger batch send
      await vi.runAllTimersAsync();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should flush after interval", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        flushIntervalMs: 1000,
      });

      sink([createEvent()]);

      // Should not send immediately
      expect(fetchMock).not.toHaveBeenCalled();

      // Advance timer
      await vi.advanceTimersByTimeAsync(1000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should send correct payload", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
      });

      const event = createEvent();
      sink([event]);

      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://logs.example.com/ingest",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ events: [event] }),
        })
      );
    });
  });

  describe("Authentication", () => {
    it("should include Bearer token", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        auth: { token: "secret-token" },
      });

      sink([createEvent()]);
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer secret-token",
          }),
        })
      );
    });

    it("should include custom secret header", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        auth: { secretHeader: "X-API-Key", token: "api-key-123" },
      });

      sink([createEvent()]);
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-API-Key": "api-key-123",
          }),
        })
      );
    });

    it("should include custom headers", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        headers: { "X-Custom": "value" },
      });

      sink([createEvent()]);
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Custom": "value",
          }),
        })
      );
    });
  });

  describe("Retry Logic", () => {
    it("should retry on 5xx errors", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        retry: { attempts: 5, backoffMs: 100 },
      });

      sink([createEvent()]);
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("should not retry on 4xx errors", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      fetchMock.mockResolvedValueOnce(new Response("", { status: 400 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        retry: { attempts: 1 },
      });

      sink([createEvent()]);
      await vi.runAllTimersAsync();

      // 4xx errors throw immediately and don't retry
      expect(fetchMock).toHaveBeenCalledTimes(1);
      consoleErrorSpy.mockRestore();
    });

    it("should use exponential backoff", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      fetchMock.mockResolvedValue(new Response("", { status: 500 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        retry: { attempts: 3, backoffMs: 100 },
      });

      const startTime = Date.now();
      sink([createEvent()]);
      await vi.runAllTimersAsync();
      const endTime = Date.now();

      // Should have made 3 attempts with exponential backoff
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Total delay should be at least 100ms + 200ms = 300ms (excluding jitter)
      expect(endTime - startTime).toBeGreaterThan(200);
      consoleErrorSpy.mockRestore();
    });
  });

  describe("Queue Management", () => {
    it("should respect max queue size", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1000, // Large batch to prevent auto-flush
        maxQueue: 5,
      });

      // Add more events than max queue
      for (let i = 0; i < 10; i++) {
        sink([createEvent({ msg: `event-${i}` })]);
      }

      // Manually flush
      await sink.flush!();
      await vi.runAllTimersAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Should only have 5 events (oldest dropped)
      expect(body.events.length).toBe(5);
    });

    it("should drop oldest events when queue is full", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1000,
        maxQueue: 3,
      });

      sink([createEvent({ msg: "1" })]);
      sink([createEvent({ msg: "2" })]);
      sink([createEvent({ msg: "3" })]);
      sink([createEvent({ msg: "4" })]);

      await sink.flush!();
      await vi.runAllTimersAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Should have events 2, 3, 4 (event 1 dropped)
      expect(body.events.map((e: LogEvent) => e.msg)).toEqual(["2", "3", "4"]);
    });
  });

  describe("Flush", () => {
    it("should flush buffered events", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1000, // Large batch
      });

      sink([createEvent()]);
      sink([createEvent()]);

      expect(fetchMock).not.toHaveBeenCalled();

      await sink.flush!();
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should handle flush with empty buffer", async () => {
      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
      });

      await expect(sink.flush!()).resolves.not.toThrow();
    });

    it("should not flush if already flushing", async () => {
      let resolveFunc: ((value: Response) => void) | null = null;
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFunc = resolve;
          })
      );

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
      });

      sink([createEvent()]);

      // Start first flush
      const flush1 = sink.flush!();

      // Try to flush again while first is in progress
      const flush2 = sink.flush!();

      // Resolve the fetch
      resolveFunc!(new Response("", { status: 200 }));

      await Promise.all([flush1, flush2]);

      // Should only call fetch once since second flush was skipped
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("Error Handling", () => {
    it("should handle network errors", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      fetchMock.mockRejectedValue(new Error("Network error"));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        retry: { attempts: 1 },
      });

      sink([createEvent()]);
      await vi.runAllTimersAsync();

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("should put failed events back in queue", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue(new Response("", { status: 200 }));

      const sink = sinkHttp({
        url: "https://logs.example.com/ingest",
        batch: 1,
        retry: { attempts: 1 },
      });

      const event = createEvent({ msg: "test" });
      sink([event]);

      await vi.runAllTimersAsync();

      // Add another event to trigger retry
      sink([createEvent({ msg: "test2" })]);
      await vi.runAllTimersAsync();

      // Both events should eventually be sent
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).events.map((event: LogEvent) => event.msg))).toEqual([["test"], ["test"], ["test2"]]);
    });
  });
});
