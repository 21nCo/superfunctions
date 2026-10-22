import { describe, expect, it } from "vitest";
import { redactSensitive } from "../src/index";

describe("shared adapter redaction", () => {
  it("redacts suffixed connection secret keys without over-redacting unrelated fields", () => {
    expect(
      redactSensitive({
        pgConnectionString: "postgres://user:pass@example.test/app",
        dbConnection: "postgres://user:pass@example.test/app",
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
      endpoint: "https://user:password@example.test/path",
      database: "postgresql://user:password@example.test/db",
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
