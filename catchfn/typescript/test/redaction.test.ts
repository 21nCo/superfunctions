import { describe, expect, it } from "vitest";
import { redactHeaders, redactObject, redactString, redactUrl } from "../src/utils/redaction.js";

describe("redactObject", () => {
  it("redacts sensitive keys in nested objects and arrays", () => {
    const redacted = redactObject({
      username: "john",
      password: "secret123",
      user: { name: "John", apiKey: "key123" },
      items: [{ id: 1, secret: "value1" }],
      accessToken: "xyz789",
    });
    expect(redacted).toEqual({
      username: "john",
      password: "[REDACTED]",
      user: { name: "John", apiKey: "[REDACTED]" },
      items: [{ id: 1, secret: "[REDACTED]" }],
      accessToken: "[REDACTED]",
    });
  });

  it("accepts custom patterns", () => {
    expect(redactObject({ publicData: "visible", customField: "hidden" }, [/customField/i])).toEqual({ publicData: "visible", customField: "[REDACTED]" });
  });

  it("redacts an own __proto__ key's contents without touching prototypes", () => {
    const input = JSON.parse('{"__proto__":{"secret":"hidden"}}');
    expect(redactObject(input).__proto__.secret).toBe("[REDACTED]");
  });
});

describe("redactString", () => {
  it("masks card numbers", () => {
    expect(redactString("Card: 1234-5678-9012-3456")).toBe("Card: XXXX-XXXX-XXXX-XXXX");
    expect(redactString("Cards: 1234567890123456 and 9876-5432-1098-7654")).not.toMatch(/\d{4}/);
  });
});

describe("redactUrl", () => {
  it("redacts sensitive and custom query parameters", () => {
    const redacted = redactUrl("https://api.example.com/data?id=123&token=abc&key=xyz");
    expect(redacted).toContain("id=123");
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("xyz");
    const custom = redactUrl("https://api.example.com?user_id=123&session=abc", ["session"]);
    expect(custom).toContain("user_id=123");
    expect(custom).not.toContain("abc");
  });

  it("keeps a plain relative path as is", () => {
    expect(redactUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("redactHeaders", () => {
  it.each(["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-access-token"])("redacts %s in any case", (name) => {
    const upper = name.toUpperCase();
    expect(redactHeaders({ [name]: "v1", [upper]: "v2", "content-type": "text/plain" })).toEqual({ [name]: "[REDACTED]", [upper]: "[REDACTED]", "content-type": "text/plain" });
  });
});
