import { Ajv, type ValidateFunction } from "ajv";

import { harnessOutputSchema } from "../schema.js";

/** Slot IDs: lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters. */
export const PANEL_SLOT_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$";
export const PANEL_NONBLANK_PATTERN = "\\S";
export const PANEL_CREDENTIAL_FINGERPRINT_PATTERN = "^[0-9a-f]{16}$";
export const PANEL_DIGEST_PATTERN = "^[0-9a-f]{64}$";
/**
 * RFC 3339 UTC timestamps as produced by `Date.prototype.toISOString`, with optional fractional seconds and in-range
 * fields. The validator also rejects calendar dates that do not exist, such as February 30.
 */
export const PANEL_TIMESTAMP_PATTERN = "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$";

const base = harnessOutputSchema.$defs;
const nonblank = { type: "string", pattern: PANEL_NONBLANK_PATTERN } as const;
const strings = { type: "array", items: { type: "string" } } as const;
const slotId = { type: "string", pattern: PANEL_SLOT_ID_PATTERN } as const;
const timestamp = { type: "string", pattern: PANEL_TIMESTAMP_PATTERN } as const;
const count = { type: "integer", minimum: 0 } as const;
const positive = { type: "integer", minimum: 1 } as const;
const panelSeverity = { enum: ["critical", "high", "medium", "low"] } as const;
const uninspected = harnessOutputSchema.properties.uninspected;

/** Shared definitions. The 0.1 `requirement`, `assessment`, `evidence`, `finding`, `codeAnchor` and `sourceReference` are reused unchanged. */
export const panelSchemaDefs = {
  ...base,
  changeSnapshot: {
    type: "object", additionalProperties: false,
    required: ["repositoryId", "host", "targetBranch", "baseCommit", "headCommit", "mergeBaseCommit", "diffDigest", "changedPaths", "capturedAt"],
    properties: { repositoryId: { type: "string" }, host: { type: "string" }, pullRequest: positive, targetBranch: { type: "string" }, baseCommit: { type: "string" }, headCommit: { type: "string" }, mergeBaseCommit: { type: "string" }, diffDigest: { type: "string" }, changedPaths: strings, capturedAt: { type: "string" } },
  },
  changeDetail: {
    type: "object", additionalProperties: false, required: ["hunksArtifact", "hunksDigest"],
    properties: { hunksArtifact: { type: "string" }, hunksDigest: { type: "string" }, since: { type: "string" }, deltaHunksArtifact: { type: "string" }, deltaHunksDigest: { type: "string" }, deltaPaths: strings },
  },
  testReceipt: {
    type: "object", additionalProperties: false,
    required: ["id", "command", "cwd", "commit", "startedAt", "finishedAt", "runtimeMs", "exitCode", "signal", "timedOut", "canceled", "stdoutDigest", "stderrDigest", "limitations"],
    properties: {
      id: { type: "string" }, command: strings, cwd: { type: "string" }, commit: { type: "string" }, startedAt: { type: "string" }, finishedAt: { type: "string" },
      runtimeMs: { type: "number", minimum: 0 }, exitCode: { anyOf: [{ type: "integer" }, { type: "null" }] }, signal: { anyOf: [{ type: "string" }, { type: "null" }] },
      timedOut: { type: "boolean" }, canceled: { type: "boolean" }, stdoutArtifact: { type: "string" }, stderrArtifact: { type: "string" }, stdoutDigest: { type: "string" }, stderrDigest: { type: "string" }, limitations: strings,
    },
  },
  runConfiguration: {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "policyDigest", "promptDigest", "harness", "inference", "execution", "contextAdapters", "profile"],
    properties: {
      schemaVersion: { const: 1 }, policyDigest: { type: "string" }, promptDigest: { type: "string" },
      harness: { type: "object", additionalProperties: false, required: ["id", "version"], properties: { id: { type: "string" }, version: { type: "string" } } },
      inference: { type: "object", additionalProperties: false, required: ["provider", "model", "auth"], properties: { provider: { type: "string" }, model: { type: "string" }, auth: { type: "string" } } },
      execution: { type: "object", additionalProperties: false, required: ["adapter", "timeoutMs", "maxOutputBytes"], properties: { adapter: { type: "string" }, timeoutMs: { type: "number" }, maxOutputBytes: { type: "number" } } },
      contextAdapters: strings, reviewCategories: { type: "array", items: base.requirement.properties.category }, profile: { type: "string" },
    },
  },
  /** The unchanged 0.1 `ReviewReport` v1, embedded as the panel's requirements report. */
  reviewReport: {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "runId", "attemptId", "createdAt", "change", "contextManifestDigest", "contextManifestArtifact", "configuration", "execution", "coverage", "coverageReasons", "requirements", "assessments", "evidence", "findings", "tests", "inspectedPaths", "uninspected", "limitations"],
    properties: {
      schemaVersion: { const: 1 }, runId: { type: "string" }, attemptId: { type: "string" }, createdAt: { type: "string" },
      change: { $ref: "#/$defs/changeSnapshot" }, contextManifestDigest: { type: "string" }, contextManifestArtifact: { type: "string" }, configuration: { $ref: "#/$defs/runConfiguration" },
      execution: { enum: ["queued", "running", "completed", "failed", "canceled", "superseded"] }, coverage: { enum: ["complete", "incomplete"] }, coverageReasons: strings,
      verdict: { enum: ["ready", "changes_requested", "needs_verification"] },
      requirements: { type: "array", items: { $ref: "#/$defs/requirement" } }, assessments: { type: "array", items: { $ref: "#/$defs/assessment" } },
      evidence: { type: "array", items: { $ref: "#/$defs/evidence" } }, findings: { type: "array", items: { $ref: "#/$defs/finding" } },
      tests: { type: "array", items: { $ref: "#/$defs/testReceipt" } }, inspectedPaths: strings, uninspected,
      normalizedEventArtifact: { type: "string" }, redactedTranscriptArtifact: { type: "string" }, limitations: strings, changeDetail: { $ref: "#/$defs/changeDetail" },
    },
  },
  panelSlot: {
    type: "object", additionalProperties: false, required: ["id", "stage", "harness", "inference", "lens", "budget"],
    properties: {
      id: slotId, stage: { enum: [1, 2, "verifier"] },
      harness: { type: "object", additionalProperties: false, required: ["adapter", "version"], properties: { adapter: nonblank, version: nonblank } },
      inference: { type: "object", additionalProperties: false, required: ["provider", "model", "auth"], properties: { provider: nonblank, model: nonblank, auth: nonblank, credentialEnv: nonblank } },
      lens: nonblank,
      budget: { type: "object", additionalProperties: false, required: ["timeoutMs", "maxOutputBytes"], properties: { timeoutMs: positive, maxOutputBytes: positive } },
    },
  },
  panelPolicy: {
    type: "object", additionalProperties: false, required: ["version", "slots", "quorum", "requirementsSlot", "incremental"],
    properties: {
      version: { const: 1 }, slots: { type: "array", minItems: 1, items: { $ref: "#/$defs/panelSlot" } },
      quorum: { type: "object", additionalProperties: false, required: ["stage1", "stage2"], properties: { stage1: count, stage2: count } },
      requirementsSlot: { anyOf: [slotId, { type: "null" }] }, maxConcurrentSlots: { type: "integer", minimum: 1, maximum: 8 }, incremental: { enum: ["full", "delta"] },
    },
  },
  slotIdentity: {
    type: "object", additionalProperties: false, required: ["harnessAdapter", "harnessVersion", "provider", "model", "auth"],
    properties: { harnessAdapter: nonblank, harnessVersion: nonblank, provider: nonblank, model: nonblank, auth: nonblank, credentialFingerprint: { type: "string", pattern: PANEL_CREDENTIAL_FINGERPRINT_PATTERN } },
  },
  slotRun: {
    type: "object", additionalProperties: false, required: ["slotId", "identity", "terminal", "voidReasons", "startedAt", "finishedAt"],
    properties: {
      slotId, identity: { $ref: "#/$defs/slotIdentity" },
      terminal: { enum: ["completed", "failed", "canceled", "quota_exhausted", "timed_out", "malformed", "void", "collapsed"] },
      voidReasons: { type: "array", uniqueItems: true, items: { enum: ["model_mismatch", "workspace_mutated", "disallowed_tool_use"] } },
      startedAt: timestamp, finishedAt: timestamp, outputArtifact: nonblank, outputDigest: { type: "string", pattern: PANEL_DIGEST_PATTERN },
      usage: { type: "object", additionalProperties: false, properties: { inputTokens: count, outputTokens: count, costUsd: { type: "number", minimum: 0 } } },
    },
    // Void runs carry their reasons; no other terminal may.
    if: { properties: { terminal: { const: "void" } } },
    then: { properties: { voidReasons: { type: "array", minItems: 1 } } },
    else: { properties: { voidReasons: { type: "array", maxItems: 0 } } },
  },
  panelFindingOrigin: { type: "object", additionalProperties: false, required: ["slotId", "lens"], properties: { slotId, lens: nonblank } },
  panelFindingVerification: {
    type: "object", additionalProperties: false, required: ["verdict", "slotId", "evidenceIds", "onBase", "reason"],
    properties: { verdict: { enum: ["confirmed", "refuted", "inconclusive"] }, slotId, evidenceIds: strings, onBase: { enum: ["present", "absent", "not_checked"] }, reason: nonblank },
  },
  panelFinding: {
    type: "object", additionalProperties: false,
    required: [...base.finding.required, "origins", "confidence", "ruleIds", "disposition"],
    properties: {
      ...base.finding.properties,
      severity: panelSeverity,
      origins: { type: "array", minItems: 1, items: { $ref: "#/$defs/panelFindingOrigin" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      ruleIds: { type: "array", items: nonblank },
      verification: { $ref: "#/$defs/panelFindingVerification" },
      disposition: { enum: ["reported", "dropped", "suppressed"] },
      dispositionReason: nonblank,
      suppressionReference: { $ref: "#/$defs/sourceReference" },
    },
  },
  panelFindingCluster: { type: "object", additionalProperties: false, required: ["id", "findingFingerprints"], properties: { id: nonblank, findingFingerprints: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } } } },
  panelReport: {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "kind", "runId", "createdAt", "change", "panelPolicyDigest", "slots", "slotRuns", "gateReceipts", "evidence", "findings", "clusters", "coverage", "coverageReasons"],
    properties: {
      schemaVersion: { const: 1 }, kind: { const: "reviewfn-panel" }, runId: nonblank, createdAt: timestamp,
      change: { $ref: "#/$defs/changeSnapshot" }, changeDetail: { $ref: "#/$defs/changeDetail" }, contextManifestDigest: { type: "string", pattern: PANEL_DIGEST_PATTERN },
      panelPolicyDigest: { type: "string", pattern: PANEL_DIGEST_PATTERN },
      slots: { type: "array", minItems: 1, items: { $ref: "#/$defs/panelSlot" } }, slotRuns: { type: "array", items: { $ref: "#/$defs/slotRun" } },
      requirementsReport: { $ref: "#/$defs/reviewReport" }, gateReceipts: { type: "array", items: { $ref: "#/$defs/testReceipt" } },
      evidence: { type: "array", items: { $ref: "#/$defs/evidence" } }, findings: { type: "array", items: { $ref: "#/$defs/panelFinding" } },
      clusters: { type: "array", items: { $ref: "#/$defs/panelFindingCluster" } },
      coverage: { enum: ["complete", "incomplete"] }, coverageReasons: { type: "array", items: nonblank },
      verdict: { enum: ["ready", "changes_requested", "needs_verification"] },
    },
    // Incomplete coverage always states at least one reason.
    if: { properties: { coverage: { const: "incomplete" } } },
    then: { properties: { coverageReasons: { type: "array", minItems: 1 } } },
  },
} as const;

type PanelDef = keyof typeof panelSchemaDefs;
function rooted<Name extends PanelDef>(name: Name) {
  return { $ref: `#/$defs/${name}`, $defs: panelSchemaDefs } as const;
}

export const panelPolicySchema = rooted("panelPolicy");
export const slotIdentitySchema = rooted("slotIdentity");
export const slotRunSchema = rooted("slotRun");
export const panelFindingSchema = rooted("panelFinding");
export const panelReportSchema = rooted("panelReport");

/**
 * Structured output for lens slots: the 0.1 harness output without requirements or assessments.
 * Lens findings use the panel severities; `info` is never emitted by a lens.
 */
export const lensOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "evidence", "inspectedPaths", "uninspected"],
  properties: {
    findings: { type: "array", items: { $ref: "#/$defs/finding" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    inspectedPaths: { type: "array", items: { type: "string" } },
    uninspected,
  },
  $defs: {
    sourceReference: base.sourceReference,
    codeAnchor: base.codeAnchor,
    evidence: base.evidence,
    finding: { ...base.finding, properties: { ...base.finding.properties, severity: panelSeverity } },
  },
} as const;

const compiled = new WeakMap<object, ValidateFunction>();

/** Strict Ajv compilation, cached by schema object identity. */
function compile(schema: Readonly<Record<string, unknown>>): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    // One Ajv instance per schema: Ajv retains every schema it compiles, and caller schemas may reuse an `$id`.
    validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/**
 * Compile a structured-output JSON Schema such as `lensOutputSchema` into a validator returning error messages.
 * Throws when the schema cannot be compiled; compiled schemas are cached by object identity.
 */
export function structuredOutputValidator(schema: Readonly<Record<string, unknown>>): (value: unknown) => string[] {
  const compiledValidator = compile(schema);
  return value => compiledValidator(value) ? [] : (compiledValidator.errors ?? []).map(error => `${error.instancePath || "/"}: ${error.message}`);
}

/**
 * Undo `strictProviderSchema` for a caller schema, judged by the caller schema itself: a null-valued object property is
 * omitted only where the compiled schema rejects that null, and validation is repeated until the value is valid or no
 * rejected null remains. A null the schema accepts, such as a required nullable property, is kept, however the schema
 * composes `required`, `$ref` (including recursive `#`), `allOf`, `anyOf`, `oneOf` or conditionals. Array items are
 * never removed. Throws when the schema cannot be compiled.
 */
export function omitOptionalNullsFor(schema: Readonly<Record<string, unknown>>): (value: unknown) => unknown {
  const validate = compile(schema);
  return value => {
    const result = structuredClone(value);
    while (!validate(result)) {
      let removed = false;
      for (const error of validate.errors ?? []) {
        const keys = error.instancePath.split("/").slice(1).map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
        const key = keys.pop();
        const parent = keys.reduce<unknown>((node, step) => typeof node === "object" && node !== null ? (node as Record<string, unknown>)[step] : undefined, result);
        if (key === undefined || typeof parent !== "object" || parent === null || Array.isArray(parent)) continue;
        const record = parent as Record<string, unknown>;
        if (Object.hasOwn(record, key) && record[key] === null) { delete record[key]; removed = true; }
      }
      if (!removed) break;
    }
    return result;
  };
}

export function validateStructuredOutput(schema: Readonly<Record<string, unknown>>, value: unknown): string[] {
  return structuredOutputValidator(schema)(value);
}

export function validateLensPayload(value: unknown): string[] {
  return validateStructuredOutput(lensOutputSchema, value);
}
