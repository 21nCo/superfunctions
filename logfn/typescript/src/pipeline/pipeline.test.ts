/**
 * Pipeline stages tests
 */

import { describe, it, expect } from "vitest";
import { redactSecFn } from "./redact.js";
import { enrichContext } from "./enrich.js";
import { withRequestIds } from "./request-ids.js";
import { sample } from "./sample.js";
import type { LogEvent } from "../types.js";

describe("Pipeline Stages", () => {
  const createEvent = (overrides?: Partial<LogEvent>): LogEvent => ({
    ts: "2026-01-14T12:00:00.000Z",
    level: "info",
    msg: "test message",
    name: "test",
    version: "0",
    ...overrides,
  });

  describe("redactSecFn", () => {
    it("should redact api keys in message", () => {
      const stage = redactSecFn();
      const event = createEvent({ msg: "API Key: api_key=secret123" });

      const result = stage(event);

      expect(result?.msg).toBe("API Key: [redacted]");
    });

    it("should redact tokens in message", () => {
      const stage = redactSecFn();
      const event = createEvent({ msg: "Token: token=abc123def" });

      const result = stage(event);

      expect(result?.msg).toContain("[redacted]");
    });

    it("should redact passwords in message", () => {
      const stage = redactSecFn();
      const event = createEvent({ msg: "Password: password=secret" });

      const result = stage(event);

      expect(result?.msg).toContain("[redacted]");
    });

    it("should redact authorization headers", () => {
      const stage = redactSecFn();
      const event = createEvent({ msg: "Authorization: Bearer token123" });

      const result = stage(event);

      expect(result?.msg).toContain("[redacted]");
    });

    it("should redact emails", () => {
      const stage = redactSecFn();
      const event = createEvent({ msg: "Email: user@example.com" });

      const result = stage(event);

      expect(result?.msg).toContain("[redacted]");
    });

    it("should redact context values", () => {
      const stage = redactSecFn();
      const event = createEvent({
        ctx: {
          apiKey: "api_key=secret",
          safe: "value",
        },
      });

      const result = stage(event);

      expect(result?.ctx?.apiKey).toBe("[redacted]");
      expect(result?.ctx?.safe).toBe("value");
    });

    it("should redact nested context values", () => {
      const stage = redactSecFn();
      const event = createEvent({
        ctx: {
          nested: {
            token: "token=secret123",
          },
        },
      });

      const result = stage(event);

      expect((result?.ctx?.nested as any).token).toContain("[redacted]");
    });

    it("should respect allowlist", () => {
      const stage = redactSecFn({ allowlist: ["userId"] });
      const event = createEvent({
        userId: "user@example.com",
      });

      const result = stage(event);

      expect(result?.userId).toBe("user@example.com");
    });

    it("should use custom patterns", () => {
      const stage = redactSecFn({
        patterns: [/credit_card=\d+/gi],
      });
      const event = createEvent({ msg: "Card: credit_card=4111111111111111" });

      const result = stage(event);

      expect(result?.msg).toBe("Card: [redacted]");
    });
  });

  describe("enrichContext", () => {
    it("should add static fields to context", () => {
      const stage = enrichContext({ service: "api", env: "prod" });
      const event = createEvent();

      const result = stage(event);

      expect(result?.ctx).toEqual({ service: "api", env: "prod" });
    });

    it("should add dynamic fields to context", () => {
      const stage = enrichContext({}, () => ({ timestamp: Date.now() }));
      const event = createEvent();

      const result = stage(event);

      expect(result?.ctx?.timestamp).toBeDefined();
    });

    it("should merge with existing context", () => {
      const stage = enrichContext({ service: "api" });
      const event = createEvent({ ctx: { userId: "123" } });

      const result = stage(event);

      expect(result?.ctx).toEqual({ service: "api", userId: "123" });
    });

    it("should allow event context to override enriched fields", () => {
      const stage = enrichContext({ service: "old" });
      const event = createEvent({ ctx: { service: "new" } });

      const result = stage(event);

      expect(result?.ctx?.service).toBe("new");
    });

    it("should merge static and dynamic fields", () => {
      const stage = enrichContext({ static: "value" }, () => ({
        dynamic: "value",
      }));
      const event = createEvent();

      const result = stage(event);

      expect(result?.ctx).toEqual({
        static: "value",
        dynamic: "value",
      });
    });
  });

  describe("withRequestIds", () => {
    it("should generate trace ID", () => {
      const stage = withRequestIds();
      const event = createEvent();

      const result = stage(event);

      expect(result?.traceId).toBeDefined();
      expect(result?.traceId).toHaveLength(32);
    });

    it("should generate span ID", () => {
      const stage = withRequestIds();
      const event = createEvent();

      const result = stage(event);

      expect(result?.spanId).toBeDefined();
      expect(result?.spanId).toHaveLength(16);
    });

    it("should generate request ID", () => {
      const stage = withRequestIds();
      const event = createEvent();

      const result = stage(event);

      expect(result?.requestId).toBeDefined();
    });

    it("should not override existing IDs", () => {
      const stage = withRequestIds();
      const event = createEvent({
        traceId: "existing-trace",
        spanId: "existing-span",
      });

      const result = stage(event);

      expect(result?.traceId).toBe("existing-trace");
      expect(result?.spanId).toBe("existing-span");
    });

    it("should use custom generator", () => {
      const stage = withRequestIds({
        generate: () => ({
          traceId: "custom-trace",
          spanId: "custom-span",
          requestId: "custom-request",
        }),
      });
      const event = createEvent();

      const result = stage(event);

      expect(result?.traceId).toBe("custom-trace");
      expect(result?.spanId).toBe("custom-span");
      expect(result?.requestId).toBe("custom-request");
    });
  });

  describe("sample", () => {
    it("should always keep events with rate 1.0", () => {
      const stage = sample({ info: 1.0 });

      let kept = 0;
      for (let i = 0; i < 100; i++) {
        const event = createEvent({ level: "info" });
        const result = stage(event);
        if (result !== null) kept++;
      }

      expect(kept).toBe(100);
    });

    it("should always drop events with rate 0.0", () => {
      const stage = sample({ info: 0.0 });

      let kept = 0;
      for (let i = 0; i < 100; i++) {
        const event = createEvent({ level: "info" });
        const result = stage(event);
        if (result !== null) kept++;
      }

      expect(kept).toBe(0);
    });

    it("should sample events probabilistically", () => {
      const stage = sample({ info: 0.5 });

      let kept = 0;
      for (let i = 0; i < 1000; i++) {
        const event = createEvent({ level: "info" });
        const result = stage(event);
        if (result !== null) kept++;
      }

      // Should keep approximately 50% (allow 10% margin)
      expect(kept).toBeGreaterThan(400);
      expect(kept).toBeLessThan(600);
    });

    it("should use default rates", () => {
      const stage = sample();

      // Error should always be kept (rate 1.0)
      const errorEvent = createEvent({ level: "error" });
      expect(stage(errorEvent)).not.toBeNull();

      // Trace should always be dropped (rate 0.0)
      const traceEvent = createEvent({ level: "trace" });
      expect(stage(traceEvent)).toBeNull();
    });

    it("should handle different rates per level", () => {
      const stage = sample({
        error: 1.0,
        warn: 1.0,
        info: 0.5,
        debug: 0.1,
        trace: 0.0,
      });

      // Error should always be kept
      const errorEvent = createEvent({ level: "error" });
      expect(stage(errorEvent)).not.toBeNull();

      // Trace should always be dropped
      const traceEvent = createEvent({ level: "trace" });
      expect(stage(traceEvent)).toBeNull();
    });
  });
});
