/**
 * Redaction utility tests
 */

import { describe, it, expect } from "vitest";
import {
  redactObject,
  redactString,
  redactUrl,
  redactHeaders,
} from "../../src/utils/redaction.js";

describe("redaction", () => {
  describe("redactObject", () => {
    it("should redact password fields", () => {
      const obj = {
        username: "john",
        password: "secret123",
        email: "john@example.com",
      };

      const redacted = redactObject(obj);

      expect(redacted.username).toBe("john");
      expect(redacted.password).toBe("[REDACTED]");
      expect(redacted.email).toBe("john@example.com");
    });

    it("should redact token fields", () => {
      const obj = {
        data: "value",
        apiKey: "abc123",
        accessToken: "xyz789",
      };

      const redacted = redactObject(obj);

      expect(redacted.data).toBe("value");
      expect(redacted.apiKey).toBe("[REDACTED]");
      expect(redacted.accessToken).toBe("[REDACTED]");
    });

    it("should handle nested objects", () => {
      const obj = {
        user: {
          name: "John",
          password: "secret",
        },
        settings: {
          theme: "dark",
          apiKey: "key123",
        },
      };

      const redacted = redactObject(obj);

      expect(redacted.user.name).toBe("John");
      expect(redacted.user.password).toBe("[REDACTED]");
      expect(redacted.settings.theme).toBe("dark");
      expect(redacted.settings.apiKey).toBe("[REDACTED]");
    });

    it("should handle arrays", () => {
      const obj = {
        items: [
          { id: 1, secret: "value1" },
          { id: 2, secret: "value2" },
        ],
      };

      const redacted = redactObject(obj);

      expect(redacted.items[0].id).toBe(1);
      expect(redacted.items[0].secret).toBe("[REDACTED]");
      expect(redacted.items[1].secret).toBe("[REDACTED]");
    });

    it("should accept custom patterns", () => {
      const obj = {
        publicData: "visible",
        customSecret: "hidden",
      };

      const redacted = redactObject(obj, [/customSecret/i]);

      expect(redacted.publicData).toBe("visible");
      expect(redacted.customSecret).toBe("[REDACTED]");
    });
  });

  describe("redactString", () => {
    it("should redact credit card numbers", () => {
      const str = "Card: 1234-5678-9012-3456";
      const redacted = redactString(str);

      expect(redacted).toBe("Card: XXXX-XXXX-XXXX-XXXX");
    });

    it("should handle multiple credit cards", () => {
      const str = "Cards: 1234567890123456 and 9876-5432-1098-7654";
      const redacted = redactString(str);

      expect(redacted).toContain("XXXX-XXXX-XXXX-XXXX");
      expect(redacted).not.toContain("1234567890123456");
    });
  });

  describe("redactUrl", () => {
    it("should redact sensitive query parameters", () => {
      const url = "https://api.example.com/data?id=123&token=abc&key=xyz";
      const redacted = redactUrl(url);

      expect(redacted).toContain("id=123");
      expect(redacted).toMatch(/token=%5BREDACTED%5D|token=\[REDACTED\]/);
      expect(redacted).toMatch(/key=%5BREDACTED%5D|key=\[REDACTED\]/);
    });

    it("should redact custom parameters", () => {
      const url = "https://api.example.com?user_id=123&session=abc";
      const redacted = redactUrl(url, ["session"]);

      expect(redacted).toContain("user_id=123");
      expect(redacted).toMatch(/session=%5BREDACTED%5D|session=\[REDACTED\]/);
    });

    it("should handle invalid URLs gracefully", () => {
      const invalid = "not-a-url";
      const redacted = redactUrl(invalid);

      expect(redacted).toBe(invalid);
    });
  });

  describe("redactHeaders", () => {
    it("should redact sensitive headers", () => {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer token123",
        cookie: "session=abc",
        "x-api-key": "key123",
      };

      const redacted = redactHeaders(headers);

      expect(redacted["content-type"]).toBe("application/json");
      expect(redacted.authorization).toBe("[REDACTED]");
      expect(redacted.cookie).toBe("[REDACTED]");
      expect(redacted["x-api-key"]).toBe("[REDACTED]");
    });

    it("should be case-insensitive", () => {
      const headers = {
        Authorization: "Bearer token",
        COOKIE: "value",
      };

      const redacted = redactHeaders(headers);

      expect(redacted.Authorization).toBe("[REDACTED]");
      expect(redacted.COOKIE).toBe("[REDACTED]");
    });
  });
});
