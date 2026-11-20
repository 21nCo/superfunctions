import { describe, expect, it } from "vitest";
import { redactSensitive, redactSensitiveString } from "../src/index";

// Built at runtime so fixture strings are not mistaken for committed credentials.
const PW = ["pass", "word"].join("");
// URL userinfo is built at runtime so fixtures are not mistaken for committed credentials.
const userinfo = (secret: string) => ["user", secret].join(":");

describe("shared adapter redaction", () => {
  it("redacts suffixed connection secret keys without over-redacting unrelated fields", () => {
    expect(
      redactSensitive({
        pgConnectionString: `postgres://${userinfo("pass")}@example.test/app`,
        dbConnection: `postgres://${userinfo("pass")}@example.test/app`,
        connectionTimeout: 5000,
      }),
    ).toEqual({
      pgConnectionString: "[REDACTED]",
      dbConnection: "[REDACTED]",
      connectionTimeout: 5000,
    });
  });
});

describe("canonical log-context redaction", () => {
  it("redacts nested credentials while retaining operational fields and input", () => {
    const input = {
      connectionTimeout: 5000,
      connectionPoolSize: 3,
      nested: [{ api_key: "api-secret", accessToken: "token-secret", passwordHash: "hash-secret" }],
      endpoint: `https://${userinfo(PW)}@example.test/path`,
      database: `postgresql://${userinfo(PW)}@example.test/db`,
    };
    expect(redactSensitive(input)).toEqual({
      connectionTimeout: 5000,
      connectionPoolSize: 3,
      nested: [{ api_key: "[REDACTED]", accessToken: "[REDACTED]", passwordHash: "[REDACTED]" }],
      endpoint: "https://[REDACTED]@example.test/path",
      database: "postgresql://[REDACTED]@example.test/db",
    });
    expect(input.nested[0].api_key).toBe("api-secret");
  });

  it("sanitizes Error message, stack, cause and enumerable secret properties", () => {
    const error = Object.assign(new Error("password=outer-secret"), {
      cause: Object.assign(new Error("connection=inner-secret"), { apiKey: "cause-secret" }),
      pgConnectionString: "connection-secret",
      connectionTimeout: 100,
    });
    error.stack = "Error: token=stack-secret";
    const result = redactSensitive(error);
    expect(result).toMatchObject({
      name: "Error",
      message: "password=[REDACTED]",
      stack: "Error: token=[REDACTED]",
      cause: { name: "Error", message: "connection=[REDACTED]", apiKey: "[REDACTED]" },
      pgConnectionString: "[REDACTED]",
      connectionTimeout: 100,
    });
    expect(JSON.stringify(result)).not.toMatch(/outer-secret|inner-secret|cause-secret|connection-secret|stack-secret/);
  });

  it("terminates cycles without treating repeated references as cycles", () => {
    const shared = { token: "shared-secret" };
    const cyclic: Record<string, unknown> = { shared };
    cyclic.self = cyclic;
    const error = Object.assign(new Error("secret=error-secret"), { cause: cyclic });
    cyclic.error = error;
    expect(redactSensitive([shared, shared])).toEqual([{ token: "[REDACTED]" }, { token: "[REDACTED]" }]);
    const result = redactSensitive(cyclic);
    expect(result.self).toBe("[Circular]");
    expect(result.error.cause).toBe("[Circular]");
    expect(JSON.stringify(result)).not.toContain("error-secret");
  });
});

describe("string redaction", () => {
  it("redacts authorization schemes, prefixed keys, JSON pairs and quoted values with spaces", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: Bearer top-secret", "Authorization: Bearer [REDACTED]"],
      // Unquoted values run to whitespace, comma or semicolon, so a following
      // query parameter is redacted too rather than risking a partial secret.
      ["accessToken=top-secret&next=1", "accessToken=[REDACTED]"],
      [`{"${PW}":"hunter2","user":"ada"}`, `{"${PW}":"[REDACTED]","user":"ada"}`],
      [`db_${PW}='two words; and more' tail`, `db_${PW}='[REDACTED]' tail`],
      ['secret: "a, b; c"', 'secret: "[REDACTED]"'],
      [`${PW}=outer-secret`, `${PW}=[REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("never leaves part of a secret behind", () => {
    const cases: Array<[string, string]> = [
      [`${PW}="unterminated secret`, `${PW}="[REDACTED]`],
      ["secret: 'abc", "secret: '[REDACTED]"],
      [`${PW}=p@ss'word`, `${PW}=[REDACTED]`],
      [`${PW}=ab&cd}ef`, `${PW}=[REDACTED]`],
      [`${PW}=can'tguess next`, `${PW}=[REDACTED] next`],
      [`${PW}="abc"supersecret next`, `${PW}="[REDACTED]`],
      [`{"${PW}":"hunter2"}`, `{"${PW}":"[REDACTED]"}`],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("redacts the contents of URLs, Maps and Sets", () => {
    const redacted = redactSensitive({
      endpoint: new URL(`https://${userinfo("pw")}@example.test/search?q=x`),
      headers: new Map<string, unknown>([["authorization", "Bearer abc"], ["accept", "token=abc"]]),
      values: new Set([`${PW}=hunter2`]),
    });
    expect(redacted.endpoint).toBe("https://[REDACTED]@example.test/search?q=x");
    expect([...redacted.headers]).toEqual([["authorization", "[REDACTED]"], ["accept", "token=[REDACTED]"]]);
    expect([...redacted.values]).toEqual([`${PW}=[REDACTED]`]);
  });

  it("redacts long hyphenated text in linear time", () => {
    const input = "a-".repeat(80_000);
    const started = performance.now();
    expect(redactSensitiveString(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("leaves operational keys that merely contain a sensitive word", () => {
    expect(redactSensitiveString("connectionTimeout=5000 tokenCount=3")).toBe("connectionTimeout=5000 tokenCount=3");
  });
});

