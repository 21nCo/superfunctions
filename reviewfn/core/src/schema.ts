import { Ajv } from "ajv";

export const harnessOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requirements", "assessments", "evidence", "findings", "inspectedPaths", "uninspected"],
  properties: {
    requirements: { type: "array", items: { $ref: "#/$defs/requirement" } },
    assessments: { type: "array", items: { $ref: "#/$defs/assessment" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    findings: { type: "array", items: { $ref: "#/$defs/finding" } },
    inspectedPaths: { type: "array", items: { type: "string" } },
    uninspected: { type: "array", items: { type: "object", additionalProperties: false, required: ["scope", "reason"], properties: { scope: { type: "string" }, reason: { type: "string" } } } },
  },
  $defs: {
    sourceReference: { type: "object", additionalProperties: false, required: ["sourceId", "anchor"], properties: { sourceId: { type: "string" }, anchor: { type: "string" }, excerpt: { type: "string" } } },
    codeAnchor: { type: "object", additionalProperties: false, required: ["commit", "path"], properties: { commit: { type: "string" }, path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, symbol: { type: "string" } } },
    requirement: { type: "object", additionalProperties: false, required: ["id", "statement", "sources", "category", "scope", "classification", "dependencies", "extraction"], properties: { id: { type: "string" }, statement: { type: "string", pattern: "\\S" }, sources: { type: "array", minItems: 1, items: { $ref: "#/$defs/sourceReference" } }, category: { enum: ["behavior", "architecture", "compatibility", "test", "migration", "documentation", "non_goal", "other"] }, scope: { type: "string" }, classification: { enum: ["mandatory", "advisory"] }, dependencies: { type: "array", items: { type: "string" } }, ambiguity: { type: "string" }, extraction: { type: "object", additionalProperties: false, required: ["harness", "promptDigest"], properties: { harness: { type: "string" }, promptDigest: { type: "string" } } } } },
    assessment: { type: "object", additionalProperties: false, required: ["requirementId", "status", "evidenceIds", "reasoning", "gaps", "confidence"], properties: { requirementId: { type: "string" }, status: { enum: ["implemented", "partial", "missing", "unverified", "not_applicable"] }, evidenceIds: { type: "array", items: { type: "string" } }, reasoning: { type: "string" }, gaps: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, waiverReference: { $ref: "#/$defs/sourceReference" } } },
    evidence: { type: "object", additionalProperties: false, required: ["id", "kind", "description"], properties: { id: { type: "string" }, kind: { enum: ["source", "code", "diff", "test", "artifact"] }, description: { type: "string" }, source: { $ref: "#/$defs/sourceReference" }, code: { $ref: "#/$defs/codeAnchor" }, receiptId: { type: "string" }, artifactDigest: { type: "string" }, sourceExclusionReason: { type: "string", minLength: 1 } } },
    finding: { type: "object", additionalProperties: false, required: ["fingerprint", "severity", "category", "title", "trigger", "impact", "direction", "evidenceIds", "basis", "requirementIds", "lifecycle"], properties: { fingerprint: { type: "string" }, severity: { enum: ["critical", "high", "medium", "low", "info"] }, category: { type: "string" }, title: { type: "string", pattern: "\\S" }, trigger: { type: "string", pattern: "\\S" }, impact: { type: "string", pattern: "\\S" }, direction: { type: "string", pattern: "\\S" }, anchor: { $ref: "#/$defs/codeAnchor" }, evidenceIds: { type: "array", items: { type: "string" } }, basis: { enum: ["reproduced", "inferred"] }, requirementIds: { type: "array", items: { type: "string" } }, lifecycle: { enum: ["new", "still_valid", "resolved", "superseded", "needs_revalidation"] } } },
  },
} as const;

const validator = new Ajv({ allErrors: true, strict: true }).compile(harnessOutputSchema);
export function validateHarnessPayload(value: unknown): string[] {
  return validator(value) ? [] : (validator.errors ?? []).map(error => `${error.instancePath || "/"}: ${error.message}`);
}

/** Keywords whose subschemas apply to the same value as the schema that holds them. */
const SAME_VALUE_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "if", "then", "else", "not"]);
/** Keywords whose values map names to subschemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const subschemas = (value: unknown): unknown[] => Array.isArray(value) ? value : [value];

/** Same-value keywords whose subschemas are alternatives: only one group member's requirements apply together. */
const ALTERNATIVES: Record<string, readonly string[]> = { anyOf: ["anyOf"], oneOf: ["oneOf"], then: ["then", "else"], else: ["then", "else"] };

/** Properties a schema, or any subschema applying to the same value, lists as required (except the excluded keywords). */
function requiredForValue(schema: unknown, into = new Set<string>(), excluded: readonly string[] = []): Set<string> {
  if (!isRecord(schema)) return into;
  if (Array.isArray(schema.required)) for (const name of schema.required) into.add(String(name));
  for (const key of SAME_VALUE_KEYWORDS) if (!excluded.includes(key)) for (const item of subschemas(schema[key])) requiredForValue(item, into);
  return into;
}

/**
 * OpenAI strict structured output requires every property, using null for optional values. An object schema requires
 * all its properties. A property gets the null alternative only where nothing that may apply to the same value requires
 * it: the schema itself, its enclosing schemas through allOf/anyOf/oneOf/if/then/else/not, and their subschemas there,
 * except alternatives (other anyOf/oneOf branches, then versus else) of the branch being converted. A null therefore
 * always means an absent property and never stands in for a required one.
 */
export function strictProviderSchema(schema: unknown = harnessOutputSchema, inherited: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(schema)) return schema.map(value => strictProviderSchema(value));
  if (!isRecord(schema)) return schema;
  const required = new Set([...inherited, ...requiredForValue(schema)]);
  const output = Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (SCHEMA_MAPS.has(key) && isRecord(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, strictProviderSchema(item)]))];
    if (SAME_VALUE_KEYWORDS.has(key)) {
      const context = ALTERNATIVES[key] ? requiredForValue(schema, new Set(inherited), ALTERNATIVES[key]) : required;
      return [key, Array.isArray(value) ? value.map(item => strictProviderSchema(item, context)) : strictProviderSchema(value, context)];
    }
    return [key, strictProviderSchema(value)];
  }));
  if (isRecord(schema.properties) && (schema.type === "object" || schema.type === undefined)) {
    output.properties = Object.fromEntries(Object.entries(output.properties as Record<string, unknown>).map(([key, value]) => [key, required.has(key) ? value : { anyOf: [value, { type: "null" }] }]));
    if (schema.type === "object") output.required = Object.keys(schema.properties);
  }
  return output;
}
export function omitOptionalNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitOptionalNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, omitOptionalNulls(item)]));
}
