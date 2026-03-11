import { describe, expect, it } from "vitest";
import { redactSensitive, redactSensitiveString } from "../src/internal/redaction";

describe("redaction", () => {
  it("redacts sensitive keys recursively", () => {
    const input = {
      operation: "search",
      auth: {
        apiKey: "secret-key",
      },
      nested: {
        token: "abc123",
        safe: "ok",
      },
    };

    expect(redactSensitive(input)).toEqual({
      operation: "search",
      auth: {
        apiKey: "[REDACTED]",
      },
      nested: {
        token: "[REDACTED]",
        safe: "ok",
      },
    });
  });

  it("redacts sensitive key-value patterns in strings", () => {
    const redacted = redactSensitiveString("Auth failed using apiKey=abc123 token:xyz");
    expect(redacted).toContain("apiKey=[REDACTED]");
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("xyz");
  });

  it("redacts credentials in URLs", () => {
    const redacted = redactSensitiveString("postgres://user:pass@localhost:5432/db and https://u:p@example.com");
    expect(redacted).toContain("postgres://[REDACTED]@localhost:5432/db");
    expect(redacted).toContain("https://[REDACTED]@example.com");
    expect(redacted).not.toContain("user:pass");
  });
});
