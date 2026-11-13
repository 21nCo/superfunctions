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

  it("is exported with its validator from the package entry", () => {
    expect(api.evidenceEventSchema).toBe(evidenceEventSchema);
    expect(api.EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect([...api.EVIDENCE_KINDS]).toEqual(["console", "network", "breadcrumb"]);
    expect(typeof api.validateEvidenceEvent).toBe("function");
  });
});
