/**
 * WatchFn ingest handler tests
 */

import { describe, it, expect } from "vitest";
import { watchLogsHandler as createHandler, type WatchLogsHandlerOptions } from "./watch.js";
const watchLogsHandler = (options: WatchLogsHandlerOptions = {}) => createHandler({ ingest: () => {}, ...options });

describe("WatchFn Ingest Handler", () => {
  const createValidEvent = () => ({
    ts: "2026-01-14T12:00:00.000Z",
    level: "info" as const,
    msg: "test message",
    name: "test",
    version: "0",
  });

  describe("Authentication", () => {
    it("should accept request with valid header auth", async () => {
      const handler = watchLogsHandler({
        auth: {
          header: "X-API-Key",
          value: "secret-key",
        },
      });

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "secret-key",
        },
        body: JSON.stringify({ events: [createValidEvent()] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);
    });

    it("should reject request with invalid header auth", async () => {
      const handler = watchLogsHandler({
        auth: {
          header: "X-API-Key",
          value: "secret-key",
        },
      });

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "wrong-key",
        },
        body: JSON.stringify({ events: [createValidEvent()] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(401);
    });

    it("should reject request with missing auth header", async () => {
      const handler = watchLogsHandler({
        auth: {
          header: "X-API-Key",
          value: "secret-key",
        },
      });

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [createValidEvent()] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(401);
    });

    it("should accept request with custom verify function", async () => {
      const handler = watchLogsHandler({
        auth: {
          verifyToken: (req) =>
            req.headers.get("Authorization") === "Bearer valid-token",
        },
      });

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-token",
        },
        body: JSON.stringify({ events: [createValidEvent()] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);
    });

    it("should work without authentication when not configured", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [createValidEvent()] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);
    });
  });

  describe("Request Validation", () => {
    it("should accept valid events", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          events: [createValidEvent(), createValidEvent()],
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);

      const body = await response.json();
      expect(body).toEqual({ accepted: 2 });
    });

    it("should reject invalid JSON", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "invalid json{",
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Invalid JSON");
    });

    it("should reject missing events field", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Missing events field");
    });

    it("should reject events that is not an array", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: "not-an-array" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Events must be an array");
    });

    it("should reject events with missing required fields", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          events: [{ msg: "test" }], // Missing required fields
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Event missing required fields");
    });

    it("should reject non-object events", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          events: ["string-event", 123],
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Invalid event format");
    });
  });

  describe("Batch Size Limits", () => {
    it("should accept batches within limit", async () => {
      const handler = watchLogsHandler({ maxBatch: 100 });

      const events = Array.from({ length: 50 }, () => createValidEvent());

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);

      const body = await response.json();
      expect(body.accepted).toBe(50);
    });

    it("should reject batches exceeding limit", async () => {
      const handler = watchLogsHandler({ maxBatch: 10 });

      const events = Array.from({ length: 20 }, () => createValidEvent());

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
      });

      const response = await handler(request);
      expect(response.status).toBe(429);

      const body = await response.json();
      expect(body.error).toBe("Batch too large");
      expect(body.maxBatch).toBe(10);
      expect(body.received).toBe(20);
    });

    it("should use default max batch of 500", async () => {
      const handler = watchLogsHandler();

      const events = Array.from({ length: 501 }, () => createValidEvent());

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
      });

      const response = await handler(request);
      expect(response.status).toBe(429);

      const body = await response.json();
      expect(body.maxBatch).toBe(500);
    });
  });

  describe("Response Format", () => {
    it("should return 202 on success", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [createValidEvent()] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("should return accepted count", async () => {
      const handler = watchLogsHandler();

      const events = [
        createValidEvent(),
        createValidEvent(),
        createValidEvent(),
      ];

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
      });

      const response = await handler(request);
      const body = await response.json();

      expect(body.accepted).toBe(3);
    });

    it("should include error details in error responses", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "invalid",
      });

      const response = await handler(request);
      const body = await response.json();

      expect(body.error).toBeDefined();
      expect(typeof body.error).toBe("string");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty events array", async () => {
      const handler = watchLogsHandler();

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);

      const body = await response.json();
      expect(body.accepted).toBe(0);
    });

    it("should handle events with optional fields", async () => {
      const handler = watchLogsHandler();

      const eventWithOptionals = {
        ...createValidEvent(),
        ctx: { userId: "123" },
        tags: ["http", "api"],
        traceId: "trace-123",
        spanId: "span-456",
        requestId: "req-789",
      };

      const request = new Request("https://example.com/watch/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [eventWithOptionals] }),
      });

      const response = await handler(request);
      expect(response.status).toBe(202);
    });
  });
});
