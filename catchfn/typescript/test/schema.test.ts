import { describe, expect, it } from "vitest";
import { evidenceEventSchema, isEvidenceEvent, validateEvidenceEvent } from "../src/events.js";
import * as api from "../src/index.js";
import { validateWithSchema } from "./schema-helper.js";

const valid = {
  console: { schemaVersion: 1, kind: "console", seq: 0, timestamp: 1, level: "warn", args: ["x", { a: [1] }] },
  network: { schemaVersion: 1, kind: "network", seq: 1, timestamp: 2, transport: "fetch", method: "GET", url: "/a", status: 200, statusText: "OK", duration: 3.5, requestHeaders: { a: "b" } },
  breadcrumb: { schemaVersion: 1, kind: "breadcrumb", seq: 2, timestamp: 3, type: "user", message: "m", data: { k: null }, category: "c", level: "warning" },
};

const invalid: Array<[string, unknown]> = [
  ["a non-object", "event"],
  ["another schema version", { ...valid.console, schemaVersion: 2 }],
  ["an unknown kind", { ...valid.console, kind: "error" }],
  ["a missing required field", { ...valid.console, args: undefined }],
  ["an extra field", { ...valid.console, extra: true }],
  ["a field of another kind", { ...valid.console, url: "/a" }],
  ["a fractional timestamp", { ...valid.console, timestamp: 1.5 }],
  ["a negative seq", { ...valid.console, seq: -1 }],
  ["an unknown console level", { ...valid.console, level: "trace" }],
  ["an unknown transport", { ...valid.network, transport: "beacon" }],
  ["a non-string header value", { ...valid.network, responseHeaders: { a: 1 } }],
  ["a negative duration", { ...valid.network, duration: -1 }],
  ["breadcrumb data that is not an object", { ...valid.breadcrumb, data: ["x"] }],
  ["an unknown breadcrumb type", { ...valid.breadcrumb, type: "click" }],
];

const strip = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("evidence event v1 schema", () => {
  it.each(Object.entries(valid))("accepts a %s event in both validators", (_kind, event) => {
    expect(validateWithSchema(event), JSON.stringify(validateWithSchema.errors)).toBe(true);
    expect(validateEvidenceEvent(event)).toEqual([]);
    expect(isEvidenceEvent(event)).toBe(true);
  });

  it.each(invalid)("rejects %s in both validators", (_label, event) => {
    expect(validateWithSchema(strip(event))).toBe(false);
    expect(validateEvidenceEvent(strip(event)).length).toBeGreaterThan(0);
  });

  // Object.prototype member names are not event fields; JSON.parse makes each an own key.
  const inherited = ["toString", "constructor", "__proto__", "hasOwnProperty"].flatMap((field) =>
    Object.entries(valid).map(([kind, event]) => [field, kind, JSON.parse(JSON.stringify(event).replace(/^\{/, `{"${field}":123,`))] as const)
  );
  it.each(inherited)("rejects an own %s field on a %s event in both validators", (field, _kind, event) => {
    expect(Object.keys(event)).toContain(field);
    expect(validateWithSchema(event)).toBe(false);
    expect(validateEvidenceEvent(event)).toContain(`${field} is not a ${event.kind} event field`);
    expect(isEvidenceEvent(event)).toBe(false);
  });

  it("does not read inherited fields as the event's own", () => {
    // JSON has no inherited fields, so only the hand-written validator sees this case.
    const event = Object.create(valid.console);
    expect(isEvidenceEvent(event)).toBe(false);
  });

  it("reports an unreadable value instead of throwing", () => {
    const throwing = new Proxy(valid.console, { ownKeys: () => { throw new Error("trap"); } });
    expect(validateEvidenceEvent(throwing)).toEqual(["event could not be read"]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateEvidenceEvent({ ...valid.breadcrumb, data: cyclic })).not.toThrow();
    expect(isEvidenceEvent({ ...valid.breadcrumb, data: cyclic })).toBe(false);
  });

  it("is exported with its validator from the package entry", () => {
    expect(api.evidenceEventSchema).toBe(evidenceEventSchema);
    expect(api.EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect([...api.EVIDENCE_KINDS]).toEqual(["console", "network", "breadcrumb"]);
    expect(typeof api.validateEvidenceEvent).toBe("function");
  });
});
