import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, harnessOutputSchema, lensOutputSchema, strictProviderSchema, type HarnessInput } from "@superfunctions/reviewfn-core";
import { CodexHarnessAdapter, type CommandRunner } from "../src/index.js";

const head = "b".repeat(40);
const input: HarnessInput = {
  runId: "run", workspace: ".",
  change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: head, mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: ["src/index.ts"], capturedAt: "2026-01-01T00:00:00.000Z" },
  context: { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "d".repeat(64) },
  policy: DEFAULT_POLICY,
  configuration: { ...DEFAULT_CONFIG, inference: { provider: "openai", model: "gpt-5.6-sol", auth: "chatgpt" } },
  testReceipts: [], prompt: "review",
};

function lensFinding(severity: string) {
  return { fingerprint: "f1", severity, category: "correctness", title: "Off by one", trigger: "Empty input", impact: "Throws", direction: "Guard the empty case", anchor: null, evidenceIds: ["E1"], basis: "inferred", requirementIds: [], lifecycle: "new" };
}
function lensPayload(severity = "high") {
  return { findings: [lensFinding(severity)], evidence: [{ id: "E1", kind: "code", description: "loop bound", source: null, code: { commit: head, path: "src/index.ts", startLine: 3, endLine: null, symbol: null }, receiptId: null, artifactDigest: null, sourceExclusionReason: null }], inspectedPaths: ["src/index.ts"], uninspected: [] };
}

/** The lens schema without its closed root, so a test can add root properties through combinators. */
function open(): Record<string, unknown> {
  const { additionalProperties: _closed, ...rest } = lensOutputSchema;
  return rest;
}

/** A fake Codex that records the schema it was given and answers with `payload`. */
function recordingAdapter(payload: unknown) {
  const seen: { schema?: unknown; invoked: boolean } = { invoked: false };
  const runner: CommandRunner = async (_command, args) => {
    seen.invoked = true;
    seen.schema = JSON.parse(await readFile(args[args.indexOf("--output-schema") + 1], "utf8"));
    await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(payload));
    return { code: 0, signal: null, stdout: '{"type":"turn.started"}\n', stderr: "", timedOut: false, canceled: false };
  };
  return { adapter: new CodexHarnessAdapter({ runner, environment: { PATH: process.env.PATH } }), seen };
}

describe("CodexHarnessAdapter outputSchema", () => {
  it("passes the lens output schema to --output-schema and accepts lens output without requirements", async () => {
    const { adapter, seen } = recordingAdapter(lensPayload());
    const output = await adapter.run({ ...input, outputSchema: lensOutputSchema });
    expect(seen.schema).toEqual(strictProviderSchema(lensOutputSchema));
    expect(seen.schema).not.toEqual(strictProviderSchema(harnessOutputSchema));
    expect(output.terminal).toBe("completed");
    expect(output.requirements).toEqual([]);
    expect(output.assessments).toEqual([]);
    const { anchor: _nullAnchor, ...finding } = lensFinding("high");
    expect(output.findings).toEqual([finding]);
    expect(output.evidence[0]).toEqual({ id: "E1", kind: "code", description: "loop bound", code: { commit: head, path: "src/index.ts", startLine: 3 } });
  });

  it("keeps the 0.1 harness schema when outputSchema is absent, so lens-shaped output is malformed", async () => {
    const { adapter, seen } = recordingAdapter(lensPayload());
    const output = await adapter.run(input);
    expect(seen.schema).toEqual(strictProviderSchema(harnessOutputSchema));
    expect(output.terminal).toBe("malformed");
    expect(output.error).toMatch(/requirements/);
  });

  it("rejects an info finding under the lens schema", async () => {
    const { adapter } = recordingAdapter(lensPayload("info"));
    const output = await adapter.run({ ...input, outputSchema: lensOutputSchema });
    expect(output.terminal).toBe("malformed");
    expect(output.error).toMatch(/severity/);
  });

  it("keeps a null the custom schema requires while still omitting optional nulls", async () => {
    const custom = { ...lensOutputSchema, required: [...lensOutputSchema.required, "notes"], properties: { ...lensOutputSchema.properties, notes: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    const { adapter, seen } = recordingAdapter({ ...lensPayload(), notes: null });
    const output = await adapter.run({ ...input, outputSchema: custom });
    expect(seen.schema).toEqual(strictProviderSchema(custom));
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    const { anchor: _nullAnchor, ...finding } = lensFinding("high");
    expect(output.findings).toEqual([finding]);
    expect(output.evidence[0]).toEqual({ id: "E1", kind: "code", description: "loop bound", code: { commit: head, path: "src/index.ts", startLine: 3 } });
  });

  it.each([
    ["required only through an allOf branch", { notes: null }, true],
    ["a discriminated union whose other branch requires the property", { notes: { kind: "y", a: null } }, false],
    // Provider-strict output carries every property, with null for an optional one, at every level.
    ["a recursive reference", { notes: { children: [{ children: [], a: null }], a: null } }, false],
  ] as const)("normalizes provider nulls for %s through the adapter", async (_name, fields, requiredOnly) => {
    const notes = { anyOf: [
      { type: "null" },
      { type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { const: "x" }, a: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "y" }, a: { type: "string" } } },
      { $ref: "#/$defs/tree" },
    ] };
    const tree = { type: "object", additionalProperties: false, required: ["children"], properties: { children: { type: "array", items: { $ref: "#/$defs/tree" } }, a: { type: "string" } } };
    // notes is optional at the root; the first case requires it only through an allOf branch, where a null must be kept.
    const allOf = requiredOnly ? { allOf: [{ type: "object", properties: { notes }, required: ["notes"] }] } : {};
    const custom = { ...lensOutputSchema, ...allOf, properties: { ...lensOutputSchema.properties, notes }, $defs: { ...lensOutputSchema.$defs, tree } };
    const { adapter } = recordingAdapter({ ...lensPayload(), ...fields });
    const output = await adapter.run({ ...input, outputSchema: custom });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.findings[0]).not.toHaveProperty("anchor");
    // The raw provider payload is validated against the provider-strict schema; the normalized 0.1 result carries no notes.
    expect(output).not.toHaveProperty("notes");
  });

  it.each([
    ["anyOf", (x: object, y: object) => ({ anyOf: [x, y] })],
    ["oneOf", (x: object, y: object) => ({ oneOf: [x, y] })],
    ["if/then/else", () => ({ type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { enum: ["x", "y"] }, a: { anyOf: [{ type: "string" }, { type: "null" }] }, note: { type: "string" } }, if: { properties: { kind: { const: "x" } } }, then: true, else: { properties: { a: { type: "string" } } } })],
  ] as const)("keeps a null only the applicable %s branch requires", async (_name, compose) => {
    // Branch x requires a nullable a; branch y requires a string a. Both have an optional note.
    const typed = (kind: string, a: object) => ({ type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { const: kind }, a, note: { type: "string" } } });
    const notes = compose(typed("x", { anyOf: [{ type: "string" }, { type: "null" }] }), typed("y", { type: "string" }));
    const custom = { ...lensOutputSchema, required: [...lensOutputSchema.required, "notes"], properties: { ...lensOutputSchema.properties, notes } };
    const run = async (kind: string) => (await recordingAdapter({ ...lensPayload(), notes: { kind, a: null, note: null } }).adapter.run({ ...input, outputSchema: custom }));
    const applicable = await run("x");
    expect(applicable.error).toBeUndefined();
    expect(applicable.terminal).toBe("completed");
    expect(applicable.findings[0]).not.toHaveProperty("anchor");
    expect((await run("y")).terminal).toBe("malformed");
  });

  it("rejects large invalid lens output promptly", async () => {
    const payload = lensPayload();
    payload.findings = Array.from({ length: 3000 }, (_, index) => ({ ...lensFinding(index ? "high" : "info"), fingerprint: `f${index}` }));
    const { adapter } = recordingAdapter(payload);
    const started = performance.now();
    const output = await adapter.run({ ...input, outputSchema: lensOutputSchema, policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 10_000_000 } } });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(output.terminal).toBe("malformed");
    expect(output.error).toMatch(/severity/);
  });

  it("omits 0.1 nulls from the harness payload even where the custom schema requires them", async () => {
    const finding = { ...lensOutputSchema.$defs.finding, required: [...lensOutputSchema.$defs.finding.required, "anchor"], properties: { ...lensOutputSchema.$defs.finding.properties, anchor: { anyOf: [{ $ref: "#/$defs/codeAnchor" }, { type: "null" }] } } };
    const custom = { ...lensOutputSchema, $defs: { ...lensOutputSchema.$defs, finding } };
    const { adapter } = recordingAdapter(lensPayload());
    const output = await adapter.run({ ...input, outputSchema: custom });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.findings[0]).not.toHaveProperty("anchor");
  });

  it("accepts output that satisfies the caller schema as given, with optional properties omitted", async () => {
    const { anchor: _anchor, ...finding } = lensFinding("high");
    const output = await recordingAdapter({ findings: [finding], evidence: [{ id: "E1", kind: "code", description: "loop bound", code: { commit: head, path: "src/index.ts" } }], inspectedPaths: [], uninspected: [] }).adapter.run({ ...input, outputSchema: lensOutputSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.findings).toEqual([finding]);
  });

  it("rejects output that satisfies a custom schema but is not a harness payload", async () => {
    const custom = { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } };
    const { adapter } = recordingAdapter({ summary: "fine" });
    const output = await adapter.run({ ...input, outputSchema: custom });
    expect(output.terminal).toBe("malformed");
  });

  it.each([
    ["an unknown keyword", { type: "object", notAKeyword: true }],
    ["a non-iterable required", { type: "object", properties: { a: { type: "string" } }, required: 5 }],
    ["a string required", { type: "object", properties: { a: { type: "string" } }, required: "ab" }],
    ["a required property that is not declared", { type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] }],
    ["a nested non-iterable required", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: { type: "object", properties: { a: { type: "string" } }, required: true } } }],
    ["minProperties, which the provider-strict form cannot preserve", { ...lensOutputSchema, minProperties: 5, properties: { ...lensOutputSchema.properties, notes: { type: "string" } } }],
    ["a nested dependentRequired", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, dependentRequired: { a: ["b"] } } } }],
    // Presence tests through required: each would read a provider null as a present property.
    ["a required property that only an allOf branch declares", { ...open(), required: [...lensOutputSchema.required, "notes"], allOf: [{ type: "object", properties: { notes: { type: "string" } } }] }],
    ["an anyOf of required-only branches", { ...open(), properties: { ...lensOutputSchema.properties, a: { type: "string" }, b: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }] }],
    ["required inside not", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: { type: "object", properties: { a: { type: "string" } }, not: { type: "object", properties: { a: true }, required: ["a"] } } } }],
    ["required inside if", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, if: { type: "object", properties: { a: true }, required: ["a"] }, then: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } } } }],
    ["a $ref inside not", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: { not: { $ref: "#/$defs/codeAnchor" } } } }],
    // The conversion does not follow references, so a referenced schema cannot share a value with declared properties.
    ["a $ref in allOf beside a required property", { ...open(), properties: { ...lensOutputSchema.properties, a: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: [...lensOutputSchema.required, "a"], allOf: [{ $ref: "#/$defs/t" }], $defs: { ...lensOutputSchema.$defs, t: { type: "object", properties: { a: { type: "string" } } } } }],
    ["a $ref in a finding's allOf that requires its anchor", { ...lensOutputSchema, $defs: { ...lensOutputSchema.$defs, finding: { ...lensOutputSchema.$defs.finding, allOf: [{ $ref: "#/$defs/mustAnchor" }] }, mustAnchor: { type: "object", properties: { anchor: { anyOf: [{ $ref: "#/$defs/codeAnchor" }, { type: "null" }] } }, required: ["anchor"] } } }],
  ])("fails before inference when outputSchema has %s", async (_name, outputSchema) => {
    const { adapter, seen } = recordingAdapter(lensPayload());
    const output = await adapter.run({ ...input, outputSchema });
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/outputSchema/);
    expect(seen.invoked).toBe(false);
  });

  it("still accepts a required property that its own object schema declares under a property test", async () => {
    // A conditional on a property's value, not its presence, is preserved: kind is required where it is declared.
    const notes = { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { enum: ["x", "y"] }, a: { type: "string" } }, if: { properties: { kind: { const: "y" } } }, then: { properties: { a: { type: "string" } } } };
    const custom = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes } };
    const output = await recordingAdapter({ ...lensPayload(), notes: { kind: "y", a: null } }).adapter.run({ ...input, outputSchema: custom });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
  });
});
