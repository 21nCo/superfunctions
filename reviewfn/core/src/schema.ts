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

/** Keywords whose values map names to subschemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const mapValues = (value: Record<string, unknown>, map: (item: unknown) => unknown) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item)]));

/**
 * OpenAI strict structured output requires every property, using null for optional values. Conversion is node-local and
 * defined for schemas inside the provider strict subset (see `unsupportedOutputSchema`): an object schema requires all its
 * properties, and a property its own object schema does not require gets the null alternative. Only schema positions
 * (properties, items, anyOf, $defs, definitions) are converted; every other keyword, including const, enum, default and
 * examples, is copied verbatim. A null therefore means an absent property only where the provider added it; a property the
 * caller schema requires keeps whatever values, including null, its own schema allows.
 */
export function strictProviderSchema(schema: unknown = harnessOutputSchema): unknown {
  if (!isRecord(schema)) return schema;
  const output = Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (SCHEMA_MAPS.has(key) && isRecord(value)) return [key, mapValues(value, strictProviderSchema)];
    if (key === "items" || key === "anyOf") return [key, Array.isArray(value) ? value.map(item => strictProviderSchema(item)) : strictProviderSchema(value)];
    return [key, value];
  }));
  if (schema.type === "object" && isRecord(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    output.properties = Object.fromEntries(Object.entries(output.properties as Record<string, unknown>).map(([key, value]) => [key, required.has(key) ? value : { anyOf: [value, { type: "null" }] }]));
    output.required = Object.keys(schema.properties);
  }
  return output;
}

const ANNOTATIONS = ["description", "title"];
const SCALAR_KEYWORDS = new Set(["type", "enum", "const", "pattern", "format", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", ...ANNOTATIONS]);
const OBJECT_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", ...ANNOTATIONS]);
const ARRAY_KEYWORDS = new Set(["type", "items", "minItems", "maxItems", ...ANNOTATIONS]);
const REF_KEYWORDS = new Set(["$ref", ...ANNOTATIONS]);
const ANY_OF_KEYWORDS = new Set(["anyOf", ...ANNOTATIONS]);
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const LOCAL_REF = /^#\/(?:\$defs|definitions)\/[^/]+$/;

/**
 * The first part of a structured-output schema outside the provider strict subset, as "<keyword> at <JSON pointer>", or
 * undefined when the whole schema is inside it. The subset is what the lens and 0.1 harness schemas use: a root
 * `type: "object"` schema, which alone may hold `$defs` or `definitions`; object schemas with `type: "object"`,
 * `properties`, `required` naming only those properties and `additionalProperties: false`; array schemas with `items`,
 * `minItems` and `maxItems`; scalar schemas with `type` (a type list of scalar types), `enum`, `const` and string or number
 * constraints; `anyOf` as a pure union; `$ref` to a local `$defs` or `definitions` entry; and `description` or `title`
 * anywhere. `anyOf` and `$ref` take no other keyword. Everything else, including allOf, oneOf, not, if/then/else,
 * presence keywords and `$async`, is reported.
 */
export function unsupportedOutputSchema(schema: unknown): string | undefined {
  if (!isRecord(schema)) return "a root that is not an object schema at /";
  if (schema.type !== "object") return `${["anyOf", "$ref"].find(key => schema[key] !== undefined) ?? "type"} at the root /, which must be a type "object" schema`;
  const { $defs, definitions, ...root } = schema;
  for (const [key, defs] of [["$defs", $defs], ["definitions", definitions]] as const) {
    if (defs === undefined) continue;
    if (!isRecord(defs)) return `${key} at /`;
    const found = firstUnsupported(Object.entries(defs).map(([name, item]): [string, unknown] => [`/${key}/${pointer(name)}`, item]));
    if (found) return found;
  }
  return unsupportedNode(root, "");
}

const pointer = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");
const located = (keyword: string, at: string) => `${keyword} at ${at || "/"}`;
const extraKeyword = (node: Record<string, unknown>, allowed: ReadonlySet<string>, at: string) => {
  const extra = Object.keys(node).find(key => !allowed.has(key));
  return extra === undefined ? undefined : located(extra, at);
};
function firstUnsupported(entries: Iterable<[string, unknown]>): string | undefined {
  for (const [at, item] of entries) {
    const found = unsupportedNode(item, at);
    if (found) return found;
  }
  return undefined;
}

function unsupportedNode(node: unknown, at: string): string | undefined {
  if (!isRecord(node)) return located("a schema that is not an object", at);
  if (node.$ref !== undefined) {
    const extra = extraKeyword(node, REF_KEYWORDS, at);
    if (extra) return `$ref beside ${extra}`;
    return typeof node.$ref === "string" && LOCAL_REF.test(node.$ref) ? undefined : located("$ref outside #/$defs or #/definitions", at);
  }
  if (node.anyOf !== undefined) {
    const extra = extraKeyword(node, ANY_OF_KEYWORDS, at);
    if (extra) return `anyOf beside ${extra}`;
    if (!Array.isArray(node.anyOf) || !node.anyOf.length) return located("an empty or non-list anyOf", at);
    return firstUnsupported(node.anyOf.map((item, index): [string, unknown] => [`${at}/anyOf/${index}`, item]));
  }
  if (node.type === "object") return unsupportedObject(node, at);
  if (node.type === "array") return extraKeyword(node, ARRAY_KEYWORDS, at) ?? unsupportedNode(node.items, `${at}/items`);
  const extra = extraKeyword(node, SCALAR_KEYWORDS, at);
  if (extra) return extra;
  if (node.type === undefined) return node.enum === undefined && node.const === undefined ? located("a schema without type, enum or const", at) : undefined;
  const types: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
  return types.every(type => SCALAR_TYPES.has(type as string)) ? undefined : located("type", at);
}

function unsupportedObject(node: Record<string, unknown>, at: string): string | undefined {
  const extra = extraKeyword(node, OBJECT_KEYWORDS, at);
  if (extra) return extra;
  if (node.additionalProperties !== false) return located("additionalProperties other than false", at);
  const properties = node.properties;
  if (!isRecord(properties)) return located("an object without properties", at);
  const declared = (name: unknown) => typeof name === "string" && Object.hasOwn(properties, name);
  if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every(declared))) return located("required", at);
  return firstUnsupported(Object.entries(properties).map(([name, item]): [string, unknown] => [`${at}/properties/${pointer(name)}`, item]));
}
export function omitOptionalNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitOptionalNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, omitOptionalNulls(item)]));
}
