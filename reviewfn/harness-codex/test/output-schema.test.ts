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

  it("rejects output that satisfies a custom schema but is not a harness payload", async () => {
    const custom = { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } };
    const { adapter } = recordingAdapter({ summary: "fine" });
    const output = await adapter.run({ ...input, outputSchema: custom });
    expect(output.terminal).toBe("malformed");
  });

  it("fails before inference when outputSchema does not compile", async () => {
    const { adapter, seen } = recordingAdapter(lensPayload());
    const output = await adapter.run({ ...input, outputSchema: { type: "object", notAKeyword: true } });
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/outputSchema/);
    expect(seen.invoked).toBe(false);
  });
});
