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

  it("is exported from the runtime-neutral entry point", () => {
    expect(runtimeNeutral.validateClientFailureEvent).toBe(validateClientFailureEvent);
    expect(runtimeNeutral.CLIENT_FAILURE_LIMITS.maxEventBytes).toBe(8192);
  });
});
