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
      ["authorization=token test-token next", "authorization=token [REDACTED]"],
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

describe("escaped keys with malformed escapes", () => {
  // user[password] with the w escaped and a malformed tail, built at runtime.
  const tails = ["%ZZ", "%", "%E0%A4"];
  const escapedKeys = tails.map((tail) => ["user%5B", "pass%77ord", "%5D", tail].join(""));

  it("masks the value in URLSearchParams, URL query, URL fragment and object keys", () => {
    for (const key of escapedKeys) {
      expect(redactSensitive(new URLSearchParams([[key, "test-leak"]]))).not.toContain("test-leak");

      const url = new URL("https://example.test/search?q=x");
      url.searchParams.set(key, "test-leak");
      const fromQuery = redactSensitive(url);
      expect(fromQuery).toContain("=[REDACTED]");
      expect(fromQuery).not.toContain("test-leak");

      const withFragment = new URL("https://example.test/search");
      withFragment.hash = new URLSearchParams([[key, "test-leak"], ["state", "ok"]]).toString();
      const fromFragment = redactSensitive(withFragment);
      expect(fromFragment).toContain("&state=ok");
      expect(fromFragment).not.toContain("test-leak");

      expect(redactSensitive({ [key]: "test-leak" })).toEqual({ [key]: "[REDACTED]" });
    }
  });

  it("keeps non-sensitive keys with malformed escapes readable", () => {
    const params = new URLSearchParams([
      ["filter%5Bcolor%5D%ZZ", "red"],
      ["page%", "2"],
      ["sort%E0%A4", "asc"],
    ]);
    expect(redactSensitive(params)).toBe("filter%255Bcolor%255D%25ZZ=red&page%25=2&sort%25E0%25A4=asc");
    expect(redactSensitive({ "page%ZZ": "2" })).toEqual({ "page%ZZ": "2" });
  });
});

describe("credentials after an authorization key", () => {
  it("prints at most the key, separator and one recognised scheme label", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: ApiKey test-api-key", "Authorization: [REDACTED]"],
      ["authorization: ApiKey test-api-key", "authorization: [REDACTED]"],
      ["Authorization: Negotiate test-ticket", "Authorization: [REDACTED]"],
      [
        'Authorization: Digest username="test-user", realm="test", nonce="test-nonce", response="test-response"',
        "Authorization: [REDACTED]",
      ],
      [
        "Authorization: AWS4-HMAC-SHA256 Credential=test-credential/scope, SignedHeaders=host, Signature=test-signature",
        "Authorization: [REDACTED]",
      ],
      ["Authorization: Bearer\ttest-token", "Authorization: Bearer\t[REDACTED]"],
      ["Authorization: Bearer  test-token", "Authorization: Bearer  [REDACTED]"],
      ["Authorization: Bearer test-token, extra-test-part", "Authorization: Bearer [REDACTED]"],
      ["Authorization: Bearer , test-token", "Authorization: [REDACTED]"],
      ["Proxy-Authorization: Digest test-response, nc=1", "Proxy-Authorization: [REDACTED]"],
      ["headers[authorization]=ApiKey test-api-key", "headers[authorization]=[REDACTED]"],
      ["Authorization: Bearer ***", "Authorization: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("keeps quoted and JSON values as before and leaves the next line readable", () => {
    expect(redactSensitiveString('{"authorization":"ApiKey test-api-key","q":"x"}')).toBe(
      '{"authorization":"[REDACTED]","q":"x"}',
    );
    expect(redactSensitiveString("Authorization: 'Digest test-response' status=401")).toBe(
      "Authorization: '[REDACTED]' status=401",
    );
    expect(redactSensitiveString("Authorization: ApiKey test-api-key, x=1\nstatus=401 q=x")).toBe(
      "Authorization: [REDACTED]\nstatus=401 q=x",
    );
    expect(redactSensitiveString("Authorization: Negotiate test-ticket\r\ntoken=test-token")).toBe(
      "Authorization: [REDACTED]\r\ntoken=[REDACTED]",
    );
  });
});

describe("scheme label without a credential after it", () => {
  it("redacts the label when the next same-line token is a name=value assignment", () => {
    // Base64 credential with trailing padding, built at runtime.
    const padded = btoa("test");
    const cases: Array<[string, string]> = [
      ["authorization=token connectionTimeout=5000", "authorization=[REDACTED]"],
      ["Authorization: Bearer x=1", "Authorization: [REDACTED]"],
      ["Authorization: Bearer status=401 requestId=test-request", "Authorization: [REDACTED]"],
      ["Authorization: Token token=test-token", "Authorization: [REDACTED]"],
      [`Authorization: Basic ${padded}`, "Authorization: Basic [REDACTED]"],
      [`Authorization: Basic ${padded} status=401`, "Authorization: Basic [REDACTED]"],
      ["Authorization: Bearer test-token\nstatus=401", "Authorization: Bearer [REDACTED]\nstatus=401"],
    ];
    expect(padded.endsWith("=")).toBe(true);
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("prints nothing after the key for AWS4 parameters", () => {
    const redacted = redactSensitiveString(
      "Authorization: AWS4-HMAC-SHA256 Credential=test-credential/scope,SignedHeaders=host,Signature=test-signature",
    );
    expect(redacted).toBe("Authorization: [REDACTED]");
  });
});

describe("URL fragments", () => {
  it("keeps non-sensitive fragment routes as written", () => {
    for (const href of [
      "https://example.test/#/callback?state=ok",
      "https://example.test/#?q=x&state=ok",
      "https://example.test/app#section-2",
      "https://example.test/#/a/b?x=1&y=2",
    ]) {
      expect(redactSensitive(new URL(href))).toBe(href);
    }
  });

  it("masks only the value of a sensitive segment in a fragment route", () => {
    const tokenKey = ["access", "token"].join("_");
    const url = new URL(`https://example.test/#/cb?state=ok&${tokenKey}=test-leak&next=/home`);
    expect(redactSensitive(url)).toBe(`https://example.test/#/cb?state=ok&${tokenKey}=[REDACTED]&next=/home`);
  });
});

describe("round-7 fragment and scheme repairs", () => {
  it("drops the scheme label when the next token is not a credential token", () => {
    expect(redactSensitiveString("Authorization: Bearer status:401")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveString("Authorization: Bearer test-token")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSensitiveString(`Authorization: Basic ${btoa("test")}`)).toBe("Authorization: Basic [REDACTED]");
  });

  it("redacts secrets that span fragment parameters or route text, as the pin does", () => {
    const authorizationKey = ["author", "ization"].join("");
    expect(redactSensitive(new URL(`https://example.test/#${authorizationKey}:test-token=`))).toBe(
      `https://example.test/#${authorizationKey}:[REDACTED]`,
    );
    const url = new URL(`https://example.test/#https://${userinfo("test-pass=")}@example.test/path`);
    expect(redactSensitive(url)).toBe("https://example.test/#https://[REDACTED]@example.test/path");
  });

  it("keeps empty query and fragment delimiters", () => {
    for (const href of [
      "https://example.test/#",
      "https://example.test/?",
      "https://example.test/?#",
      "https://example.test/path?q=1#",
    ]) {
      expect(redactSensitive(new URL(href))).toBe(href);
    }
  });

  it("redacts long fragments in linear time", () => {
    const routes = new URL(`https://example.test/#/${"x".repeat(48_000)}`);
    const params = new URL(`https://example.test/#/cb?${"q=1&".repeat(12_000)}state=ok`);
    const started = performance.now();
    expect(redactSensitive(routes)).toBe(routes.href);
    expect(redactSensitive(params)).toBe(params.href);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
