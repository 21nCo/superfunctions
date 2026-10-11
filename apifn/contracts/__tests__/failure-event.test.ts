import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, validateClientFailureEvent } from "../src/index.js";
import * as runtimeNeutral from "../src/failure-event.js";
import { clone, FIXTURES, fixture } from "./helpers.js";

const list = (kind: "valid" | "invalid") =>
  readdirSync(path.join(FIXTURES, "client-failure", kind)).filter((file) => file.endsWith(".json")).sort();

describe("client-failure event envelope", () => {
  it.each(list("valid"))("valid fixture %s round-trips byte-identically", (file) => {
    const event = fixture(`client-failure/valid/${file}`);
    const result = validateClientFailureEvent(clone(event));
    expect(result).toEqual({ ok: true, event });
    if (result.ok) expect(canonicalJson(result.event)).toBe(canonicalJson(event));
  });

  it.each(list("invalid"))("invalid fixture %s is rejected with its documented issue", (file) => {
    const { event, expectedIssues } = fixture(`client-failure/invalid/${file}`);
    const result = validateClientFailureEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map(({ path: issuePath, code }) => ({ path: issuePath, code }))).toEqual(expectedIssues);
      for (const issue of result.issues) expect(issue.message).not.toMatch(/abcdefghijklmnop|session=|redacted/);
    }
  });

  it("measures limits in UTF-8 bytes, not characters", () => {
    const event = fixture("client-failure/valid/network-minimal.json");
    const atLimit = validateClientFailureEvent({ ...clone(event), failure: { kind: "unknown", message: "é".repeat(512) } });
    const overLimit = validateClientFailureEvent({ ...clone(event), failure: { kind: "unknown", message: `${"é".repeat(512)}x` } });
    expect(atLimit.ok).toBe(true);
    expect(overLimit.ok).toBe(false);
  });

  it.each([
    ["URL user info", { pathTemplate: "/x", name: undefined }, { message: "fetch https://svc:hunter2pass@api.example.test failed" }],
    ["URL user info without a password", {}, { message: "fetch https://hunter2hunter2@api.example.test failed" }],
    ["URL user info with several @", {}, { message: "fetch https://x@hunter2hunter2@api.example.test failed" }],
    ["protocol-relative URL user info", {}, { message: "fetch //svc:hunter2hunter2@api.example.test failed" }],
    ["lowercase bearer token", {}, { message: "sent Authorization: Bearer abcdefghijklmnop" }],
    ["JWT", {}, { errorCode: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl" }],
    ["query credential", {}, { message: "GET /v1/projects?access_token=abc123 failed" }],
    ["provider key", {}, { message: "rejected key sk_live_abcdefgh12345678" }],
  ])("rejects credential-like values: %s", (_name, operation, failure) => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    Object.assign(event.operation, operation);
    Object.assign(event.failure, failure);
    const result = validateClientFailureEvent(JSON.parse(JSON.stringify(event)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toEqual(["CREDENTIAL_VALUE"]);
  });

  it("accepts prose that names an authentication scheme", () => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    for (const message of ["Bearer authentication required", "Requires HTTP Basic authentication", "contact support@example.test"]) {
      expect(validateClientFailureEvent({ ...event, failure: { kind: "http", httpStatus: 401, message } }).ok, message).toBe(true);
    }
  });

  it.each([
    ["top-level constructor", '{"constructor":"x"}', "/constructor"],
    ["top-level __proto__", '{"__proto__":{"a":1}}', "/__proto__"],
    ["failure.constructor", '{"failure":{"kind":"unknown","constructor":"x"}}', "/failure/constructor"],
    ["failure.toString", `{"failure":{"kind":"unknown","toString":"${"x".repeat(4000)}"}}`, "/failure/toString"],
    ["failure.hasOwnProperty", '{"failure":{"kind":"unknown","hasOwnProperty":"x"}}', "/failure/hasOwnProperty"],
    ["release.__proto__", '{"release":{"releaseId":"rel_0123456789abcdef01234567","__proto__":{"x":1}}}', "/release/__proto__"],
  ])("reports Object.prototype names as unknown fields: %s", (_name, patch, issuePath) => {
    const base = clone(fixture("client-failure/valid/network-minimal.json"));
    const input = JSON.parse(patch);
    for (const key of Object.keys(input)) {
      const value = input[key];
      Object.defineProperty(base, key, { value: key === "__proto__" || key === "constructor" ? value : { ...base[key], ...value }, enumerable: true, writable: true, configurable: true });
    }
    let result: ReturnType<typeof validateClientFailureEvent> | undefined;
    expect(() => {
      result = validateClientFailureEvent(base);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path: issuePath, code: "UNKNOWN_FIELD" })] });
  });

  it.each<[string, (event: any) => any, string]>([
    ["attributes as a Map", (event) => ({ ...event, attributes: new Map([["region", "eu"]]) }), "/attributes"],
    ["runtime as a class instance", (event) => ({ ...event, runtime: new (class Runtime { name = "node"; })() }), "/runtime"],
    ["api as a Date", (event) => ({ ...event, api: new Date(0) }), "/api"],
    ["the event as a class instance", (event) => Object.assign(new (class Event {})(), event), ""],
    ["a throwing getter", (event) => Object.defineProperty({ ...event }, "eventId", { enumerable: true, get: () => { throw new Error("boom"); } }), ""],
  ])("returns a TYPE issue instead of throwing for %s", (_name, mutate, issuePath) => {
    const input = mutate(clone(fixture("client-failure/valid/network-minimal.json")));
    let result: ReturnType<typeof validateClientFailureEvent> | undefined;
    expect(() => {
      result = validateClientFailureEvent(input);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path: issuePath, code: "TYPE" })] });
  });

  it.each(["2026-99-99T99:99:99Z", "2026-02-30T12:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T08:00:00Z", "2026-10-11T24:00:00Z"])(
    "rejects the impossible timestamp %s",
    (occurredAt) => {
      const event = clone(fixture("client-failure/valid/network-minimal.json"));
      const result = validateClientFailureEvent({ ...event, occurredAt });
      expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path: "/occurredAt", code: "PATTERN" })] });
    }
  );

  it("accepts leap days, leap seconds and fractional seconds", () => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    for (const occurredAt of ["2024-02-29T23:59:60.123Z", "2000-02-29T00:00:00Z", "2026-12-31T23:59:59.999999999Z"]) {
      expect(validateClientFailureEvent({ ...event, occurredAt }).ok, occurredAt).toBe(true);
    }
  });

  it("is exported from the runtime-neutral entry point", () => {
    expect(runtimeNeutral.validateClientFailureEvent).toBe(validateClientFailureEvent);
    expect(runtimeNeutral.CLIENT_FAILURE_LIMITS.maxEventBytes).toBe(8192);
  });
});
