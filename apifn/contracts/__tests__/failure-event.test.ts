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
    ["a self-cycle", (event) => {
      const loop: Record<string, unknown> = {};
      loop.x = loop;
      return { ...event, failure: { kind: "unknown", extra: loop } };
    }, "/failure/extra/x"],
    ["nesting past the depth limit", (event) => {
      let node: unknown = 1;
      for (let level = 0; level < 300; level += 1) node = [node];
      return { ...event, failure: { kind: "unknown", extra: node } };
    }, expect.stringMatching(/^\/failure\/extra(?:\/0)+$/) as never],
  ])("returns a TYPE issue instead of throwing for %s", (_name, mutate, issuePath) => {
    const input = mutate(clone(fixture("client-failure/valid/network-minimal.json")));
    let result: ReturnType<typeof validateClientFailureEvent> | undefined;
    expect(() => {
      result = validateClientFailureEvent(input);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path: issuePath, code: "TYPE" })] });
  });

  it("reports a fan-out self-cycle at once instead of copying it per path", () => {
    const loop: Record<string, unknown> = {};
    loop.x = loop;
    loop.y = loop;
    const started = Date.now();
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    const result = validateClientFailureEvent({ ...event, failure: { kind: "unknown", extra: loop } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({
      ok: false,
      issues: [expect.objectContaining({ path: "/failure/extra/x", code: "TYPE" }), expect.objectContaining({ path: "/failure/extra/y", code: "TYPE" })],
    });
  });

  // Cost and output are bounded by maxEventBytes, not by the input: reading stops before any key or value is scanned.
  it.each<[string, (event: any) => any]>([
    ["one 60k-character top-level key", (event) => ({ ...event, ["a+".repeat(30_000)]: 1 })],
    ["one 60k-character failure key", (event) => ({ ...event, failure: { kind: "unknown", ["a+".repeat(30_000)]: 1 } })],
    ["one 60k-character attribute key", (event) => ({ ...event, attributes: { ["a+".repeat(30_000)]: "x" } })],
    ["200 keys of 2k characters", (event) => Object.assign({ ...event }, Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`${"a+".repeat(1000)}${index}`, 1])))],
    ["a 60k-character message", (event) => ({ ...event, failure: { kind: "unknown", message: "Authorization: ".concat("a".repeat(60_000)) } })],
    ["a sparse array of 50M items", (event) => ({ ...event, failure: { kind: "unknown", extra: new Array(50_000_000) } })],
    ["200k functions", (event) => ({ ...event, failure: { kind: "unknown", extra: Array.from({ length: 200_000 }, () => () => 1) } })],
    ["2^40 paths through shared references", (event) => {
      let node: Record<string, unknown> = { leaf: 1 };
      for (let level = 0; level < 40; level += 1) node = { a: node, b: node };
      return { ...event, failure: { kind: "unknown", extra: node } };
    }],
  ])("stops reading at the event size limit: %s", (_name, mutate) => {
    const input = mutate(clone(fixture("client-failure/valid/network-minimal.json")));
    const started = performance.now();
    const result = validateClientFailureEvent(input);
    expect(performance.now() - started).toBeLessThan(250);
    expect(result).toEqual({ ok: false, issues: [{ path: "", code: "TOO_LARGE", message: expect.stringContaining("8192 bytes") }] });
  });

  it("stops after 32 problems, however many the input holds", () => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    const result = validateClientFailureEvent({ ...event, failure: { kind: "unknown", extra: Array.from({ length: 100 }, () => () => 1) } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toEqual(Array(32).fill("TYPE"));
  });

  it("applies the size bound to the serialized event exactly: just under is accepted, just over is TOO_LARGE", () => {
    const base = clone(fixture("client-failure/valid/network-minimal.json"));
    // Attribute values fill the event; the size check must agree with the canonical serialization at the boundary.
    const sized = (bytes: number) => {
      const attributes: Record<string, string> = {};
      const event = { ...base, attributes };
      for (let index = 0; index < 32; index += 1) {
        const room = bytes - new TextEncoder().encode(canonicalJson(event)).length;
        if (room <= 0) break;
        const key = `k${String(index).padStart(2, "0")}`;
        attributes[key] = "v".repeat(Math.min(256, Math.max(1, room - key.length - 6)));
      }
      return event;
    };
    for (const target of [8192, 8193]) {
      const event = sized(target);
      const bytes = new TextEncoder().encode(canonicalJson(event)).length;
      const result = validateClientFailureEvent(event);
      expect(bytes).toBe(target);
      expect(result.ok, `${bytes} bytes`).toBe(bytes <= 8192);
      if (!result.ok) expect(result.issues.map((issue) => issue.code)).toEqual(["TOO_LARGE"]);
    }
  });

  it("validates and returns one snapshot, so a getter cannot swap in a credential after the check", () => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    let reads = 0;
    const failure = {};
    Object.defineProperty(failure, "kind", { enumerable: true, value: "http" });
    Object.defineProperty(failure, "message", {
      enumerable: true,
      get: () => (reads++ === 0 ? "safe message" : "Authorization: Bearer stolen123"),
    });
    const result = validateClientFailureEvent({ ...event, failure });
    expect(reads).toBe(1);
    expect(result).toEqual({ ok: true, event: { ...event, failure: { kind: "http", message: "safe message" } } });
  });

  it("rejects attribute keys and unknown field names that hold a credential, without echoing it", () => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    const result = validateClientFailureEvent({ ...event, attributes: { sk_live_abcdefgh12345678: "x" }, failure: { kind: "unknown", "token=SEEDkey01": 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["CREDENTIAL_KEY", "CREDENTIAL_KEY"]);
      expect(JSON.stringify(result.issues)).not.toMatch(/abcdefgh12345678|SEEDkey01/);
    }
  });

  // The attributes object follows the text name/value rule, as failure.message does.
  it.each<[string, Record<string, string>, string]>([
    ["name", { name: "X-Api-Key", value: "SEEDattr0082" }, "/attributes/value"],
    ["key", { key: "client_secret", value: "SEEDattr0082" }, "/attributes/value"],
    ["header", { header: "Authorization", header_value: "Bearer SEEDattr0082" }, "/attributes/header_value"],
  ])("rejects an attribute value named as a credential by the %s attribute", (_field, attributes, path) => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    const result = validateClientFailureEvent({ ...event, attributes });
    expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ path, code: "CREDENTIAL_VALUE" })] });
    expect(JSON.stringify(result)).not.toContain("SEEDattr0082");
    expect(validateClientFailureEvent({ ...event, failure: { kind: "unknown", message: JSON.stringify(attributes) } }).ok).toBe(false);
  });

  it.each([{ name: "X-Request-Id", value: "req-42" }, { name: "X-Api-Key", value: "<token>" }])("accepts the attributes %j", (attributes) => {
    const event = clone(fixture("client-failure/valid/network-minimal.json"));
    expect(validateClientFailureEvent({ ...event, attributes })).toEqual({ ok: true, event: { ...event, attributes } });
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
