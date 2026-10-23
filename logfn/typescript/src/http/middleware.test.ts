/**
 * Middleware utilities tests
 */

import { describe, it, expect } from "vitest";
import {
  extractCorrelationIds,
  redactHeaders,
  truncateBody,
} from "./middleware.js";

describe("Middleware Utilities", () => {
  describe("extractCorrelationIds", () => {
    it("should parse W3C TraceContext from header", () => {
      const headers = {
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      };

      const ids = extractCorrelationIds(headers);

      expect(ids.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
      expect(ids.spanId).toBe("b7ad6b7169203331");
      expect(ids.requestId).toBeDefined();
      expect(ids.requestId).toHaveLength(32);
    });

    it("should generate new IDs if header is missing", () => {
      const headers = {};

      const ids = extractCorrelationIds(headers);

      expect(ids.traceId).toBeDefined();
      expect(ids.traceId).toHaveLength(32);
      expect(ids.spanId).toBeDefined();
      expect(ids.spanId).toHaveLength(16);
      expect(ids.requestId).toBeDefined();
      expect(ids.requestId).toHaveLength(32);
    });

    it("should handle custom header name", () => {
      const headers = {
        "x-trace-id": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      };

      const ids = extractCorrelationIds(headers, "x-trace-id");

      expect(ids.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    });

    it("should handle array header values", () => {
      const headers = {
        traceparent: [
          "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        ],
      };

      const ids = extractCorrelationIds(headers);

      expect(ids.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    });

    it("should generate IDs for invalid traceparent format", () => {
      const headers = {
        traceparent: "invalid-format",
      };

      const ids = extractCorrelationIds(headers);

      expect(ids.traceId).toBeDefined();
      expect(ids.traceId).toHaveLength(32);
    });
  });

  describe("redactHeaders", () => {
    it("should redact default sensitive headers", () => {
      const headers = {
        authorization: "Bearer secret-token",
        cookie: "session=abc123",
        "x-api-key": "api-key-123",
        "content-type": "application/json",
      };

      const redacted = redactHeaders(headers);

      expect(redacted["authorization"]).toBe("[redacted]");
      expect(redacted["cookie"]).toBe("[redacted]");
      expect(redacted["x-api-key"]).toBe("[redacted]");
      expect(redacted["content-type"]).toBe("application/json");
    });

    it("should redact custom header list", () => {
      const headers = {
        "x-custom-secret": "secret",
        "x-public": "public",
      };

      const redacted = redactHeaders(headers, ["x-custom-secret"]);

      expect(redacted["x-custom-secret"]).toBe("[redacted]");
      expect(redacted["x-public"]).toBe("public");
    });

    it("should be case-insensitive", () => {
      const headers = {
        Authorization: "Bearer token",
        COOKIE: "session=123",
      };

      const redacted = redactHeaders(headers);

      expect(redacted["Authorization"]).toBe("[redacted]");
      expect(redacted["COOKIE"]).toBe("[redacted]");
    });

    it("should handle array header values", () => {
      const headers = {
        authorization: ["Bearer token1", "Bearer token2"],
      };

      const redacted = redactHeaders(headers);

      expect(redacted["authorization"]).toBe("[redacted]");
    });

    it("should skip undefined headers", () => {
      const headers = {
        "content-type": "application/json",
        empty: undefined,
      };

      const redacted = redactHeaders(headers);

      expect(redacted["content-type"]).toBe("application/json");
      expect(redacted["empty"]).toBeUndefined();
    });
  });

  describe("truncateBody", () => {
    it("should return body as-is if under size limit", () => {
      const body = { message: "Hello world" };

      const truncated = truncateBody(body);

      expect(truncated).toEqual(body);
    });

    it("should truncate large bodies", () => {
      const body = { data: "x".repeat(10000) };

      const truncated = truncateBody(body, 100);

      expect(truncated).toHaveProperty("_truncated", true);
      expect(truncated).toHaveProperty("_size");
      expect(truncated).toHaveProperty("_preview");
      expect(truncated._preview).toHaveLength(200);
    });

    it("should handle string bodies", () => {
      const body = "x".repeat(10000);

      const truncated = truncateBody(body, 100);

      expect(truncated).toHaveProperty("_truncated", true);
    });

    it("should return undefined for null/undefined body", () => {
      expect(truncateBody(null)).toBeUndefined();
      expect(truncateBody(undefined)).toBeUndefined();
    });

    it("should use default max size of 8KB", () => {
      // 1000 chars ~= 1018 bytes when serialized as {"data":"xxx..."}
      const body = { data: "x".repeat(1000) };

      const truncated = truncateBody(body);

      expect(truncated).toEqual(body); // Under 8KB
    });
  });
});
