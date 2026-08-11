import { describe, expect, it } from "vitest";

import {
  McpFnRegistry,
  createManifest,
  diffManifests,
  structuredResult,
  validateManifest,
} from "../src/index.js";

function registry(required: string[] = ["value"], description = "Store a value.") {
  return new McpFnRegistry().register({
    name: "store",
    description,
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
        label: { type: "string" },
      },
      required,
      additionalProperties: false,
    },
    handler: async () => structuredResult({ ok: true }),
  });
}

describe("McpFn manifests", () => {
  it("creates deterministic, self-validating manifests", () => {
    const first = createManifest(
      { name: "example", version: "1.0.0" },
      registry(),
      { transports: ["stdio", "streamable-http", "stdio"] },
    );
    const second = createManifest(
      { name: "example", version: "1.0.0" },
      registry(),
      { transports: ["streamable-http", "stdio"] },
    );
    expect(first).toEqual(second);
    expect(validateManifest(first)).toEqual(first);
  });

  it("classifies required inputs as breaking and descriptions as behavioral", () => {
    const before = createManifest(
      { name: "example", version: "1.0.0" },
      registry(["value"]),
    );
    const after = createManifest(
      { name: "renamed", version: "1.1.0", instructions: "Use labeled values." },
      registry(["value", "label"], "Store a labeled value."),
    );
    const diff = diffManifests(before, after);
    expect(diff.compatible).toBe(false);
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "requiredness-broken", severity: "breaking" }),
        expect.objectContaining({ code: "tool-description-changed", severity: "behavioral" }),
        expect.objectContaining({ code: "server-name-changed", severity: "breaking" }),
        expect.objectContaining({ code: "server-instructions-changed", severity: "behavioral" }),
      ]),
    );
  });

  it("applies input and output variance to enum and constraint changes", () => {
    const before = createManifest(
      { name: "example", version: "1.0.0" },
      new McpFnRegistry().register({
        name: "choose",
        description: "Choose a value.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", enum: ["a", "b"] } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string", enum: ["a"], pattern: "^a$" } },
          required: ["value"],
          additionalProperties: false,
        },
        metadata: { revision: 1 },
        handler: async () => structuredResult({ value: "a" }),
      }),
    );
    const after = createManifest(
      { name: "example", version: "1.1.0" },
      new McpFnRegistry().register({
        name: "choose",
        description: "Choose a value.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", enum: ["a"] } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string", enum: ["a", "b"] } },
          required: ["value"],
          additionalProperties: false,
        },
        metadata: { revision: 2 },
        handler: async () => structuredResult({ value: "a" }),
      }),
    );

    expect(diffManifests(before, after).changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "enum-narrowed", severity: "breaking" }),
      expect.objectContaining({ code: "enum-widened", severity: "breaking" }),
      expect.objectContaining({ code: "schema-keyword-changed", severity: "breaking" }),
      expect.objectContaining({ code: "tool-metadata-changed", severity: "behavioral" }),
    ]));
  });

  it("rejects malformed manifest contracts before comparing them", () => {
    const manifest = createManifest(
      { name: "example", version: "1.0.0" },
      registry(),
    );
    expect(() => validateManifest({
      ...manifest,
      tools: [{ ...manifest.tools[0], name: "contains whitespace" }],
    })).toThrow(/requires a name/);
    const reversedTools = createManifest(
      { name: "example", version: "1.0.0" },
      registry().register({
        name: "another",
        description: "Another tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      }),
    );
    expect(() => validateManifest({
      ...reversedTools,
      tools: [...reversedTools.tools].reverse(),
    })).toThrow(/sorted and unique/);
    expect(() => validateManifest({
      ...manifest,
      tools: [{
        ...manifest.tools[0],
        inputSchema: { type: "object", properties: { value: { minimum: "invalid" } } },
      }],
    })).toThrow(/invalid JSON Schema/);
  });

  it("treats required or closed-schema output additions as breaking", () => {
    const create = (
      required: string[],
      additionalProperties: boolean,
      includeAdded: boolean,
    ) => createManifest(
      { name: "example", version: "1.0.0" },
      new McpFnRegistry().register({
        name: "output",
        description: "Return output.",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
            ...(includeAdded ? { added: { type: "string" } } : {}),
          },
          required,
          additionalProperties,
        },
        handler: async () => structuredResult({ value: "ok", added: "new" }),
      }),
    );
    for (const [before, after] of [
      [create(["value"], false, false), create(["value"], false, true)],
      [create(["value"], true, false), create(["value", "added"], true, true)],
    ]) {
      expect(diffManifests(before, after)).toMatchObject({
        compatible: false,
        changes: expect.arrayContaining([
          expect.objectContaining({ code: "output-property-added", severity: "breaking" }),
        ]),
      });
    }
  });

  it("treats new client-mediated requirements as breaking", () => {
    const before = createManifest(
      { name: "example", version: "1.0.0" },
      registry(),
    );
    const after = createManifest(
      { name: "example", version: "1.1.0" },
      registry(),
      { clientRequirements: { sampling: true, elicitation: ["form"] } },
    );
    expect(diffManifests(before, after)).toMatchObject({
      compatible: false,
      changes: expect.arrayContaining([
        expect.objectContaining({
          path: "clientRequirements.sampling",
          severity: "breaking",
        }),
        expect.objectContaining({
          path: "clientRequirements.elicitation",
          severity: "breaking",
        }),
      ]),
    });
  });
});
