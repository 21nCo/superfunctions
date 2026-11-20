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

describe("keys that still hold percent escapes after parsing", () => {
  it("redacts URLSearchParams and URL keys whose decoded form is sensitive", () => {
    // user[password] with the w escaped, built at runtime for the secret scan.
    const escapedKey = ["user%5B", "pass%77ord", "%5D"].join("");
    const params = new URLSearchParams([
      [escapedKey, "test-leak"],
      ["q", "x"],
    ]);
    const fromParams = redactSensitive(params);
    expect(fromParams).toBe("user%255Bpass%2577ord%255D=[REDACTED]&q=x");
    expect(fromParams).not.toContain("test-leak");

    const url = new URL("https://example.test/search?q=x");
    url.searchParams.set(escapedKey, "test-leak");
    const fromUrl = redactSensitive(url);
    expect(fromUrl).toBe("https://example.test/search?q=x&user%255Bpass%2577ord%255D=[REDACTED]");
    expect(fromUrl).not.toContain("test-leak");
  });

  it("keeps non-sensitive keys and malformed escapes readable", () => {
    const params = new URLSearchParams([
      ["filter%5Bcolor%5D", "red"],
      ["bad%E0%A4%A", "ok"],
    ]);
    expect(redactSensitive(params)).toBe("filter%255Bcolor%255D=red&bad%25E0%25A4%25A=ok");
  });
});

describe("bracketed keys in plain strings", () => {
  it("redacts values after ] or %5D closers and keeps quotes", () => {
    const cases: Array<[string, string]> = [
      [`GET /_search?user%5B${PW}%5D=test-leak`, `GET /_search?user%5B${PW}%5D=[REDACTED]`],
      [`GET /_search?user%5b${PW}%5d=test-leak&q=x`, `GET /_search?user%5b${PW}%5d=[REDACTED]`],
      [`user[${PW}]=test-leak`, `user[${PW}]=[REDACTED]`],
      [`{"user[${PW}]":"test-leak","q":"x"}`, `{"user[${PW}]":"[REDACTED]","q":"x"}`],
      ["headers[authorization]=Bearer test-leak", "headers[authorization]=Bearer [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });
});

describe("auth scheme on its own line", () => {
  it("does not carry the scheme match across a line break", () => {
    expect(redactSensitiveString("Authorization: Bearer\nstatus=401")).toBe("Authorization: [REDACTED]\nstatus=401");
    expect(redactSensitiveString("Authorization: Bearer\r\nstatus=401")).toBe("Authorization: [REDACTED]\r\nstatus=401");
    expect(redactSensitiveString("Authorization:\tBasic\ttest-leak\nstatus=401")).toBe(
      "Authorization:\tBasic\t[REDACTED]\nstatus=401",
    );
    expect(redactSensitiveString("Authorization: Bearer test-leak")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSensitiveString(`${PW}=basic connectionTimeout=5000`)).toBe(`${PW}=[REDACTED]`);
  });
});
