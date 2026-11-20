import { describe, expect, it } from "vitest";
import { redactSensitive, redactSensitiveString } from "../src/index";

// Sensitive key words and URL userinfo are built at runtime so fixture strings
// are not mistaken for committed credentials.
const PW = ["pass", "word"].join("");
const userinfo = (secret: string) => ["user", secret].join(":");

describe("auth scheme words as secret values", () => {
  it("redacts the whole value when a non-authorization key holds bearer, basic or token", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED]`],
      ["token=bearer connectionTimeout=5000", "token=[REDACTED]"],
      ["api_key=token connectionTimeout=5000", "api_key=[REDACTED]"],
      ["accessToken: Bearer test-token", "accessToken: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("keeps the scheme after an authorization key and redacts its credential", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      ["Proxy-Authorization: Basic test-credential", "Proxy-Authorization: Basic [REDACTED]"],
      ["authorization=token test-token next", "authorization=token [REDACTED] next"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });
});

describe("query containers", () => {
  it("redacts URLSearchParams values by decoded key, including bracketed keys", () => {
    const params = new URLSearchParams([
      [`user[${PW}]`, "test-password"],
      ["filter[token]", "test-token"],
      ["q", "red shoes"],
      ["page", "2"],
    ]);
    const redacted = redactSensitive(params);
    expect(redacted).toBe(`user%5B${PW}%5D=[REDACTED]&filter%5Btoken%5D=[REDACTED]&q=red+shoes&page=2`);
    expect(redacted).not.toMatch(/test-password|test-token/);
  });

  it("redacts percent-encoded keys in URL query strings and fragments", () => {
    const url = new URL(
      `https://example.test/search?user%5Btoken%5D=test-token&pass%77ord=test-password&q=x#access_token=test-fragment&state=ok`,
    );
    const redacted = redactSensitive({ endpoint: url }).endpoint;
    expect(redacted).toBe(
      "https://example.test/search?user%5Btoken%5D=[REDACTED]&password=[REDACTED]&q=x#access_token=[REDACTED]&state=ok",
    );
    expect(redacted).not.toMatch(/test-token|test-password|test-fragment/);
  });

  it("redacts URL userinfo and sensitive params together while keeping the rest readable", () => {
    const url = new URL(`postgres://${userinfo("test-password")}@db.example.test:5432/app?sslmode=require&passwd=test-passwd`);
    const redacted = redactSensitive(url);
    expect(redacted).toBe("postgres://[REDACTED]@db.example.test:5432/app?sslmode=require&passwd=[REDACTED]");
  });

  it("still redacts key=value secrets inside non-sensitive parameter values", () => {
    const params = new URLSearchParams([["note", "token=test-token"]]);
    expect(redactSensitive(params)).toBe("note=token%3D[REDACTED]");
  });
});
