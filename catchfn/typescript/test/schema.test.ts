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

  it("accepts only plain or null-prototype records in nested data and header records", () => {
    class Box {
      value = "x";
    }
    // A Date becomes a string in JSON, so the schema rejects what a consumer receives.
    const changedByJson: Array<[string, unknown]> = [
      ["a Date as breadcrumb data", { ...valid.breadcrumb, data: new Date(0) }],
      ["a Date as request headers", { ...valid.network, requestHeaders: new Date(0) }],
    ];
    for (const [label, event] of changedByJson) {
      expect(validateWithSchema(strip(event)), label).toBe(false);
      expect(validateEvidenceEvent(event), label).not.toEqual([]);
    }
    // Other non-plain records are not JSON data either; the validator rejects them as is.
    const nonPlain: Array<[string, unknown]> = [
      ["a class instance as breadcrumb data", { ...valid.breadcrumb, data: new Box() }],
      ["a Date nested in breadcrumb data", { ...valid.breadcrumb, data: { when: new Date(0) } }],
      ["a Map nested in console args", { ...valid.console, args: [new Map([["a", 1]])] }],
      ["a class instance as response headers", { ...valid.network, responseHeaders: new Box() }],
    ];
    for (const [label, event] of nonPlain) expect(validateEvidenceEvent(event), label).not.toEqual([]);
    // A toJSON hook, own or inherited, enumerable or not, changes the JSON form.
    const hook = { value: () => "not a record" };
    const withHook = (target: object) => Object.defineProperty(target, "toJSON", hook);
    const hooked: Array<[string, unknown]> = [
      ["breadcrumb data with a hidden toJSON", { ...valid.breadcrumb, data: withHook({ a: 1 }) }],
      ["breadcrumb data inheriting toJSON", { ...valid.breadcrumb, data: Object.create(withHook(Object.create(null))) }],
      ["request headers with a hidden toJSON", { ...valid.network, requestHeaders: withHook({ a: "b" }) }],
      ["console args with a hidden toJSON", { ...valid.console, args: withHook(["x"]) }],
      ["a nested array with a hidden toJSON", { ...valid.console, args: [withHook([1])] }],
    ];
    for (const [label, event] of hooked) {
      expect(validateEvidenceEvent(event), label).not.toEqual([]);
      expect(isEvidenceEvent(event), label).toBe(false);
    }
    // The event object itself follows the same rule.
    const hookedEvents: Array<[string, unknown]> = [
      ["an event with a hidden toJSON", withHook({ ...valid.console })],
      ["an event inheriting toJSON", Object.assign(Object.create(withHook(Object.create(null))), valid.console)],
      ["a Date event", Object.assign(new Date(0), valid.console)],
      ["a class-instance event", Object.assign(new Box(), valid.breadcrumb)],
    ];
    for (const [label, event] of hookedEvents) {
      expect(validateEvidenceEvent(event), label).toEqual(["event must be a plain object"]);
      expect(isEvidenceEvent(event), label).toBe(false);
    }
    expect(validateEvidenceEvent(Object.assign(Object.create(null), valid.network))).toEqual([]);
    // A toJSON key holding data is kept by JSON.stringify, and both validators accept it.
    const dataKey = { ...valid.breadcrumb, data: { toJSON: "keep", nested: [{ toJSON: null }] } };
    expect(validateEvidenceEvent(dataKey)).toEqual([]);
    expect(validateWithSchema(strip(dataKey))).toBe(true);
    expect(strip(dataKey)).toEqual(dataKey);
    const bare = { ...valid.breadcrumb, data: Object.assign(Object.create(null), { nested: Object.assign(Object.create(null), { a: 1 }) }) };
    expect(validateEvidenceEvent(bare)).toEqual([]);
    expect(validateWithSchema(strip(bare))).toBe(true);
  });

  it("bounds every integer field at Number.MAX_SAFE_INTEGER in both validators", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["seq", valid.console],
      ["timestamp", valid.console],
      ["status", valid.network],
    ];
    for (const [field, event] of cases) {
      const atBound = { ...event, [field]: Number.MAX_SAFE_INTEGER };
      const pastBound = { ...event, [field]: Number.MAX_SAFE_INTEGER + 1 };
      expect(validateWithSchema(atBound), field).toBe(true);
      expect(validateEvidenceEvent(atBound), field).toEqual([]);
      expect(validateWithSchema(pastBound), field).toBe(false);
      expect(validateEvidenceEvent(pastBound), field).toEqual([`${field} is invalid`]);
    }
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
