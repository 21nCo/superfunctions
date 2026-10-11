import { readdirSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  API_ID_PATTERN,
  CREDENTIAL_KEY_PATTERN,
  NAME_PATTERN,
  OPERATION_ID_PATTERN,
  RELEASE_ID_PATTERN,
  TARGET_PATTERN,
  VERSION_PATTERN,
  validateClientFailureEvent,
} from "../src/index.js";
import { FIXTURES, fixture, readJson, SCHEMAS } from "./helpers.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const schema = (name: string) => readJson(path.join(SCHEMAS, `${name}.v1.schema.json`));
const validators = Object.fromEntries(
  ["manifest", "operation-catalog", "release-descriptor", "client-failure-event"].map((name) => [name, ajv.compile(schema(name))])
);

function check(name: string, value: unknown): boolean {
  return validators[name](value) as boolean;
}

describe("published JSON Schemas", () => {
  it("accept the committed manifest, catalog and release fixtures", () => {
    for (const file of ["catalog/manifest.json", "parity/manifest.json"]) expect(check("manifest", fixture(file))).toBe(true);
    expect(check("operation-catalog", fixture("catalog/catalog.json")), JSON.stringify(validators["operation-catalog"].errors)).toBe(true);
    expect(check("release-descriptor", fixture("catalog/release-descriptor.json"))).toBe(true);
  });

  it("reject manifests that bind an operation both ways or neither way", () => {
    const base = { manifestVersion: 1, api: { id: "example.projects", version: "1" } };
    expect(check("manifest", { ...base, operations: [{ id: "a", operationId: "x", method: "get", path: "/x" }] })).toBe(false);
    expect(check("manifest", { ...base, operations: [{ id: "a" }] })).toBe(false);
    expect(check("manifest", { ...base, operations: [{ id: "a", method: "get", path: "/x" }] })).toBe(true);
  });

  it("agree with the TypeScript validator on every failure-event fixture", () => {
    const dir = path.join(FIXTURES, "client-failure");
    for (const file of readdirSync(path.join(dir, "valid"))) {
      const event = readJson(path.join(dir, "valid", file));
      expect(check("client-failure-event", event), file).toBe(true);
      expect(validateClientFailureEvent(event).ok, file).toBe(true);
    }
    // Byte limits, credential-like values and total size are enforced only by
    // validateClientFailureEvent; the schema's description documents this.
    const runtimeOnly = new Set(["credential-value-message.json", "oversize-attribute-value.json", "oversize-event.json"]);
    for (const file of readdirSync(path.join(dir, "invalid"))) {
      const { event } = readJson(path.join(dir, "invalid", file));
      expect(validateClientFailureEvent(event).ok, file).toBe(false);
      expect(check("client-failure-event", event), file).toBe(runtimeOnly.has(file));
    }
  });

  it("share identifier patterns with the TypeScript contract", () => {
    const manifest = schema("manifest");
    const failure = schema("client-failure-event");
    const binding = manifest.$defs.binding.properties;
    expect(manifest.properties.api.properties.id.pattern).toBe(API_ID_PATTERN.source);
    expect(manifest.properties.api.properties.version.pattern).toBe(VERSION_PATTERN.source);
    expect(binding.id.pattern).toBe(OPERATION_ID_PATTERN.source);
    expect(binding.name.pattern).toBe(NAME_PATTERN.source);
    expect(binding.sdk.properties.excludeTargets.items.pattern).toBe(TARGET_PATTERN.source);
    expect(failure.properties.release.properties.releaseId.pattern).toBe(RELEASE_ID_PATTERN.source);
    expect(failure.properties.attributes.propertyNames.not.pattern).toBe(CREDENTIAL_KEY_PATTERN);
    expect(schema("release-descriptor").properties.releaseId.pattern).toBe(RELEASE_ID_PATTERN.source);
  });
});
