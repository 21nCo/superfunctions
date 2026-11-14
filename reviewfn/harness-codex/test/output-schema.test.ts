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

  // A pure anyOf union of a null, two object branches and a recursive reference: every value has one object node per branch.
  const unionNotes = { anyOf: [
    { type: "null" },
    { type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { const: "x" }, a: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "y" }, a: { type: "string" } } },
    { $ref: "#/$defs/tree" },
  ] };
  const tree = { type: "object", additionalProperties: false, required: ["children"], properties: { children: { type: "array", items: { $ref: "#/$defs/tree" } }, a: { type: "string" } } };
  const unionSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: unionNotes }, $defs: { ...lensOutputSchema.$defs, tree } };

  it.each([
    ["the branch that leaves a optional", { notes: { kind: "y", a: null } }],
    // Provider-strict output carries every property, with null for an optional one, at every level.
    ["a recursive reference", { notes: { children: [{ children: [], a: null }], a: null } }],
  ] as const)("normalizes provider nulls of a pure anyOf union through %s", async (_name, fields) => {
    const { adapter } = recordingAdapter({ ...lensPayload(), ...fields });
    const output = await adapter.run({ ...input, outputSchema: unionSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.findings[0]).not.toHaveProperty("anchor");
    // The raw provider payload is validated against the provider-strict schema; the normalized 0.1 result carries no notes.
    expect(output).not.toHaveProperty("notes");
  });

  it.each([
    ["a null where the branch requires a string", { kind: "x", a: null }],
    ["a value matching no branch", { kind: "z", a: "set" }],
  ] as const)("marks output with %s malformed", async (_name, notes) => {
    const output = await recordingAdapter({ ...lensPayload(), notes }).adapter.run({ ...input, outputSchema: unionSchema });
    expect(output.terminal).toBe("malformed");
  });

  it("keeps a null only the applicable anyOf branch allows", async () => {
    // Branch x requires a nullable a; branch y requires a string a. Both have an optional note.
    const typed = (kind: string, a: object) => ({ type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { const: kind }, a, note: { type: "string" } } });
    const notes = { anyOf: [typed("x", { type: ["string", "null"] }), typed("y", { type: "string" })] };
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
    ["a nested non-iterable required", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes: { type: "object", properties: { a: { type: "string" } }, required: true } } }],
  ])("fails before inference when outputSchema is not a valid JSON Schema: %s", async (_name, outputSchema) => {
    const { adapter, seen } = recordingAdapter(lensPayload());
    const output = await adapter.run({ ...input, outputSchema });
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/^outputSchema is not a valid JSON Schema/);
    expect(seen.invoked).toBe(false);
  });

  const notesSchema = (notes: object) => ({ ...lensOutputSchema, properties: { ...lensOutputSchema.properties, notes } });
  const object = (properties: object, extra: object = {}) => ({ type: "object", additionalProperties: false, properties, ...extra });
  // "uses": well-formed but outside the provider strict subset; "invalid": already rejected by the strict Ajv compile.
  it.each([
    // The pullfrog reproduction: a same-node $ref whose target requires a non-null anchor beside a finding's properties.
    ["$ref", "uses", "a $ref beside properties", { ...lensOutputSchema, $defs: { ...lensOutputSchema.$defs, finding: { ...lensOutputSchema.$defs.finding, $ref: "#/$defs/mustAnchor" }, mustAnchor: object({ anchor: { $ref: "#/$defs/codeAnchor" } }, { required: ["anchor"] }) } }],
    ["required", "invalid", "a $ref beside required", notesSchema({ $ref: "#/$defs/codeAnchor", required: ["path"] })],
    ["allOf", "uses", "allOf", { ...lensOutputSchema, allOf: [object({ findings: { type: "array" } })] }],
    ["oneOf", "uses", "oneOf", notesSchema({ oneOf: [{ type: "string" }, { type: "integer" }] })],
    ["not", "uses", "not", notesSchema({ type: "string", not: { const: "x" } })],
    ["if", "uses", "if/then/else", notesSchema(object({ kind: { enum: ["x", "y"] }, a: { type: "string" } }, { if: { properties: { kind: { const: "x" } } }, then: object({ a: { type: "string" } }, { required: ["a"] }), else: {} }))],
    ["contains", "uses", "contains", notesSchema({ type: "array", items: { type: "string" }, contains: { const: "x" } })],
    ["minProperties", "uses", "minProperties", { ...lensOutputSchema, minProperties: 5 }],
    ["dependentRequired", "invalid", "a nested dependentRequired", notesSchema(object({ a: { type: "string" }, b: { type: "string" } }, { dependentRequired: { a: ["b"] } }))],
    ["anyOf", "uses", "a root anyOf", { anyOf: [lensOutputSchema], $defs: lensOutputSchema.$defs }],
    // The coderabbit shape: a property required only inside one anyOf branch beside the root properties.
    ["anyOf", "uses", "anyOf beside properties and required", { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, kind: { enum: ["x", "y"] }, p: { type: "string" } }, anyOf: [object({ kind: { const: "x" }, p: { type: "string" } }, { required: ["p"] }), object({ kind: { const: "y" } })] }],
    ["additionalProperties", "uses", "an object without additionalProperties false", notesSchema({ type: "object", properties: { a: { type: "string" } } })],
    ["additionalProperties", "invalid", "properties without type object", notesSchema({ properties: { a: { type: "string" } }, additionalProperties: false })],
    ["required", "invalid", "a required property that is not declared", { ...lensOutputSchema, required: [...lensOutputSchema.required, "notes"] }],
    ["$async", "invalid", "$async", { ...lensOutputSchema, $async: true }],
    ["$defs", "uses", "nested $defs", notesSchema(object({ a: { $ref: "#/$defs/codeAnchor" } }, { $defs: { x: { type: "string" } } }))],
    ["default", "uses", "a default", notesSchema({ type: "string", default: "x" })],
  ])("fails before inference when outputSchema has %s (%s: %s)", async (keyword, kind, _name, outputSchema) => {
    const { adapter, seen } = recordingAdapter(lensPayload());
    const output = await adapter.run({ ...input, outputSchema });
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(kind === "uses" ? /^outputSchema uses .*, which the provider strict subset does not support\.$/ : /^outputSchema is not a valid JSON Schema: /);
    expect(output.error).toContain(keyword);
    expect(seen.invoked).toBe(false);
  });

  it("copies const and enum literals verbatim, even when they look like schemas", async () => {
    const literal = { type: "object", properties: { p: { type: "string" } } };
    const custom = notesSchema(object({ shape: { const: literal }, choice: { enum: [literal, "plain"] } }, { required: ["shape", "choice"] }));
    const { adapter, seen } = recordingAdapter({ ...lensPayload(), notes: { shape: literal, choice: literal } });
    const output = await adapter.run({ ...input, outputSchema: custom });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    const sent = (seen.schema as { properties: { notes: { anyOf: [{ properties: Record<string, unknown> }] } } }).properties.notes.anyOf[0].properties;
    expect(sent).toEqual({ shape: { const: literal }, choice: { enum: [literal, "plain"] } });
  });
});
