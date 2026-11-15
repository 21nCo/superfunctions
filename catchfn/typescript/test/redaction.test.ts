import { describe, expect, it } from "vitest";
import { redactHeaders, redactObject, redactString, redactUrl } from "../src/utils/redaction.js";
import { MAX_ENTRY_BYTES, utf8Length } from "../src/utils/serialization.js";

describe("redactObject", () => {
  it("redacts sensitive keys in nested objects and arrays", () => {
    const redacted = redactObject({
      username: "example-user",
      password: "not-a-real-password",
      user: { name: "John", apiKey: "key123" },
      items: [{ id: 1, secret: "value1" }],
      accessToken: "xyz789",
    });
    expect(redacted).toEqual({
      username: "example-user",
      password: "[REDACTED]",
      user: { name: "John", apiKey: "[REDACTED]" },
      items: [{ id: 1, secret: "[REDACTED]" }],
      accessToken: "[REDACTED]",
    });
  });

  it("accepts custom patterns", () => {
    expect(redactObject({ publicData: "visible", customField: "hidden" }, [/customField/i])).toEqual({ publicData: "visible", customField: "[REDACTED]" });
  });

  it(`stays within ${MAX_ENTRY_BYTES} bytes when redaction makes values longer`, () => {
    const expanding = { password: 0, token: 0, secret: 0, auth: 0, text: "x".repeat(20000) };
    const redacted = redactObject(expanding);
    expect(utf8Length(JSON.stringify(redacted))).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(redacted).toMatchObject({ password: "[REDACTED]", token: "[REDACTED]", secret: "[REDACTED]", auth: "[REDACTED]" });
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`token${index}`, index]));
    const bounded = redactObject({ many, filler: "y".repeat(9000) });
    expect(utf8Length(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(JSON.stringify(bounded)).not.toMatch(/"token\d+":\d/);
  });

  it("redacts an own __proto__ key's contents without touching prototypes", () => {
    const input = JSON.parse('{"__proto__":{"secret":"hidden"}}');
    const redacted = redactObject(input);
    expect(Object.hasOwn(redacted, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(redacted.__proto__.secret).toBe("[REDACTED]");
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
