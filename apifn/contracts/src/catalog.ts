import { parseOpenAPI } from "@apifn/core";
import { parse as parseYaml } from "yaml";
import { canonicalDigest, canonicalJson, compareCodeUnits, MAX_JSON_DEPTH, snapshotPlainData } from "./canonical.js";
import {
  containsCredentialIdentifier,
  containsCredentialValue,
  credentialValueFields,
  isCredentialKey,
  isAmbiguousUrl,
  isCredentialPair,
  pointerSegment,
  quote,
  REDACTED,
  redactWhole,
  removedServerUrlSpans,
  sanitizePointer,
  sanitizeReport,
  stripUrlCredentials,
} from "./credentials.js";
import { isSupportedMediaType, mediaTypeParameters, normalizeMediaType, validateManifest } from "./manifest.js";
import {
  CATALOG_VERSION,
  type ApiManifest,
  type BuildCatalogResult,
  type CatalogContent,
  type CatalogOperation,
  type CatalogEncoding,
  type CatalogParameter,
  type CatalogResponse,
  type CatalogSecurityScheme,
  type CatalogServer,
  type Diagnostic,
  type HttpMethod,
  type JsonValue,
  type OperationBinding,
  type OperationCatalog,
  type SecurityRequirementTerm,
} from "./types.js";

type Doc = Record<string, unknown>;

const METHODS: HttpMethod[] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const PARAMETER_LOCATIONS = ["path", "query", "header", "cookie"] as const;
const PARAMETER_STYLES: Record<CatalogParameter["in"], string[]> = {
  path: ["simple"],
  query: ["form", "deepObject"],
  header: ["simple"],
  cookie: ["form"],
};
/** OpenAPI ignores header parameters with these names (OAS 3.1 §4.8.12.1). */
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);
/** Request media types whose properties can carry an Encoding Object. */
const FORM_MEDIA_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data"]);
const RESPONSE_STATUS = /^(?:[1-5](?:\d\d|XX)|default)$/;
/** Keywords whose values are property names: checked like property names and copied verbatim, never redacted. */
const NAME_KEYWORDS = new Set(["required", "dependentRequired"]);
/** OpenAPI objects inside a schema; only their own `x-*` members are extensions. */
const OBJECT_KEYWORDS = new Set(["xml", "externalDocs"]);
/**
 * Non-literal keywords kept inside a credential field. Anything else there
 * (an unrecognized member could hold a default under another name) is dropped.
 */
const CREDENTIAL_FIELD_KEYWORDS = new Set([
  "type", "format", "title", "description", "$comment", "$id", "$schema", "$anchor", "$dynamicAnchor",
  "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern",
  "maxItems", "minItems", "uniqueItems", "maxContains", "minContains", "maxProperties", "minProperties",
  "nullable", "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType", "discriminator",
  ...NAME_KEYWORDS, ...OBJECT_KEYWORDS,
]);
/**
 * Schema keywords holding a reference. `$dynamicRef` and `$recursiveRef` are
 * checked and collected like `$ref`: a copied reference whose target is not a
 * catalog schema would dangle.
 */
const REFERENCE_KEYWORDS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_KEYWORDS = new Set([
  "items",
  "not",
  "additionalProperties",
  "contains",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]);
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/** Applicators whose subschemas describe the same instance as the schema holding them, as `$ref` targets do. */
const SAME_INSTANCE_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas"]);
const COMPONENT_SCHEMA_PREFIX = "#/components/schemas/";
const SECURITY_SCHEME_TYPES = ["apiKey", "http", "mutualTLS", "oauth2", "openIdConnect"];
const API_KEY_LOCATIONS = ["query", "header", "cookie"];
/** The OAuth flows OpenAPI 3.0/3.1 define, each with the URLs it requires. */
const OAUTH_FLOW_URLS: Record<string, ReadonlyArray<"authorizationUrl" | "tokenUrl">> = {
  implicit: ["authorizationUrl"],
  password: ["tokenUrl"],
  clientCredentials: ["tokenUrl"],
  authorizationCode: ["authorizationUrl", "tokenUrl"],
};
const NAME_MAX_LENGTH = 128;
/**
 * Nesting limit for the OpenAPI document and manifest. A catalog nests a
 * copied value at most 3 levels deeper than the document does (a parameter
 * behind `#/x-param` moves to /operations/<i>/parameters/<j>) and release
 * input nests the catalog 1 level deeper, so this margin keeps every catalog
 * within MAX_JSON_DEPTH for createReleaseDescriptor.
 */
const MAX_DOCUMENT_DEPTH = MAX_JSON_DEPTH - 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property lookup, so names such as "constructor" never resolve through Object.prototype. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Defines an own data property; plain assignment would treat "__proto__" as the prototype. */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Drops the `x-*` members of one OpenAPI object; nested values stay verbatim. */
function withoutExtensions(value: unknown): unknown {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("x-"))) : value;
}

/** True when a key names a credential or holds one. */
function isCredentialMember(key: string): boolean {
  return isCredentialKey(key) || containsCredentialIdentifier(key);
}

/**
 * True when JSON data holds, at any depth, a credential-named or
 * credential-bearing key, or a name naming a credential next to its value, as
 * the text rules read them: a name field and a value field
 * (`{name: "X-Api-Key", value: "..."}`) or a pair (`["X-Api-Key", "..."]`).
 */
function hasCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return isCredentialPair(value) || value.some(hasCredentialKey);
  if (!isRecord(value)) return false;
  return credentialValueFields(value).length > 0 || Object.entries(value).some(([key, child]) => isCredentialMember(key) || hasCredentialKey(child));
}

/**
 * The literal text of a regular expression: character classes, escapes,
 * anchors, groups and quantifiers become spaces, so `^token=[a-z]+$` reads
 * as `token=` (no value) while `^sk_live_abc123…$` keeps its key.
 */
function patternLiterals(pattern: string): string {
  return pattern.replace(/\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|\{\d*(?:,\d*)?\}|[\^$()|?*+]/g, " ");
}

interface MemberType<T> {
  name: string;
  accepts: (value: unknown) => value is T;
}

const OBJECT: MemberType<Record<string, unknown>> = { name: "an object", accepts: isRecord };
const LIST: MemberType<unknown[]> = { name: "an array", accepts: Array.isArray };
const STRING: MemberType<string> = { name: "a string", accepts: (value): value is string => typeof value === "string" };
const BOOLEAN: MemberType<boolean> = { name: "a boolean", accepts: (value): value is boolean => typeof value === "boolean" };
const STRING_LIST: MemberType<string[]> = {
  name: "an array of strings",
  accepts: (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"),
};

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const NUMBER: MemberType<number> = { name: "a number", accepts: (value): value is number => typeof value === "number" };
const NON_NEGATIVE_INTEGER: MemberType<number> = { name: "a non-negative integer", accepts: (value): value is number => Number.isInteger(value) && (value as number) >= 0 };
/**
 * The JSON type of every schema keyword the catalog emits with a fixed type.
 * A wrong type is INVALID_SPEC: copying it would publish a schema that
 * generated clients misread, and literal data must never pass under another type.
 */
const SCHEMA_KEYWORD_TYPES = new Map<string, MemberType<unknown>>([
  [
    "type",
    {
      name: "a JSON type name or a non-empty array of distinct type names",
      accepts: (value): value is unknown =>
        typeof value === "string" ? JSON_TYPES.has(value) : Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((item) => typeof item === "string" && JSON_TYPES.has(item)),
    },
  ],
  ["enum", LIST],
  ["multipleOf", { name: "a number greater than 0", accepts: (value): value is number => typeof value === "number" && value > 0 }],
  ...["maximum", "minimum"].map((key): [string, MemberType<unknown>] => [key, NUMBER]),
  // The OpenAPI 3.0 boolean form is converted where the keyword is copied.
  ...["exclusiveMaximum", "exclusiveMinimum"].map((key): [string, MemberType<unknown>] => [key, { name: "a number or a boolean", accepts: (value): value is unknown => typeof value === "number" || typeof value === "boolean" }]),
  ...["maxLength", "minLength", "maxItems", "minItems", "maxProperties", "minProperties", "maxContains", "minContains"].map((key): [string, MemberType<unknown>] => [key, NON_NEGATIVE_INTEGER]),
  ...["pattern", "format", "title", "description", "$comment", "contentMediaType", "contentEncoding"].map((key): [string, MemberType<unknown>] => [key, STRING]),
  ...["uniqueItems", "readOnly", "writeOnly", "deprecated", "nullable"].map((key): [string, MemberType<unknown>] => [key, BOOLEAN]),
]);

function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

interface Expansion {
  text: string;
  /** Where each substituted value lands in `text`. */
  spans: Array<{ name: string; start: number; end: number }>;
}

/** The `{name}` placeholders of a server URL template, counted by name, in one pass as {@link expandServerUrl} reads them. */
function placeholderCounts(url: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of url.matchAll(/\{([^{}]*)\}/g)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return counts;
}

/** Expands `{name}` server variables, recording where each value lands; undeclared ones stay as written. */
function expandServerUrl(url: string, values: Record<string, string>, override?: { name: string; value: string }): Expansion {
  const spans: Expansion["spans"] = [];
  let text = "";
  let copied = 0;
  for (const match of url.matchAll(/\{([^{}]*)\}/g)) {
    text += url.slice(copied, match.index);
    copied = match.index + match[0].length;
    const name = match[1];
    const value = name === override?.name ? override.value : Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      text += match[0];
      continue;
    }
    spans.push({ name, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text: text + url.slice(copied), spans };
}

/**
 * Judges the value of server variable `name` in `template` expanded with
 * `values` (every other variable at its own value, so values that only
 * together form user info or a query are judged together). A value that
 * touches nothing the catalog removes is kept. User info lying wholly inside
 * the value is cut out of it (`svc:pw@api.test` as `{authority}` becomes
 * `api.test`, `https://svc:pw@api.test` as `{base}` becomes
 * `https://api.test`). Otherwise every variable touching the removed part is
 * hidden.
 */
function judgeServerValue(
  template: string,
  values: Record<string, string>,
  name: string,
  raw: string,
  charge: () => boolean
): { value: string; cut: boolean } | { hide: string[] } | { overflow: true } {
  if (!charge()) return { overflow: true };
  const expansion = expandServerUrl(template, values, { name, value: raw });
  const overlaps = (span: { start: number; end: number }, part: { start: number; end: number }) => span.start < part.end && span.end > part.start;
  const own = expansion.spans.filter((span) => span.name === name);
  const hits = removedServerUrlSpans(expansion.text).filter((part) => own.some((span) => overlaps(span, part)));
  if (hits.length === 0) return { value: raw, cut: false };
  const [part] = hits;
  const occurrence = own.find((span) => span.start <= part.start && span.end >= part.end);
  if (hits.length === 1 && part.userInfo && occurrence && expansion.spans.every((span) => span === occurrence || !overlaps(span, part))) {
    const value = raw.slice(0, part.start - occurrence.start) + raw.slice(part.end - occurrence.start);
    // A shorter value expands no longer, so the same charge bounds the retry.
    const retry = judgeServerValue(template, values, name, value, charge);
    return "value" in retry ? { value: retry.value, cut: true } : retry;
  }
  return { hide: Array.from(new Set(expansion.spans.filter((span) => hits.some((hit) => overlaps(span, hit))).map((span) => span.name))) };
}

/** Charges `budget` with `characters` of server URL work before it is done; false, with nothing charged, when too little is left. */
function chargeBudget(budget: { characters: number }, characters: number): boolean {
  if (characters > budget.characters) return false;
  budget.characters -= characters;
  return true;
}

/** The most combinations of server variable values judged one by one; beyond it the judgement fails closed. */
const SERVER_COMBINATION_LIMIT = 4096;
/**
 * The most characters of expanded server URLs judged together in one build.
 * Each combination expands the whole URL, so the combination limit alone
 * would let long values cost combinations x length; this keeps the work of a
 * build linear in its input.
 */
const SERVER_SCAN_BUDGET = 4_000_000;

/**
 * Hides every visible variable that some combination of declared values puts
 * into user info, a query or a fragment of the expanded `template`. A hidden
 * variable's values are never published, so it takes each raw value; a
 * visible one each value the catalog would publish. Hiding a variable widens
 * its values to the raw ones, so this repeats until nothing more is hidden.
 * When any value or the template holds `@`, `?` or `#` (without one nothing
 * can be removed) and the combinations exceed {@link SERVER_COMBINATION_LIMIT}
 * or their expanded URLs would exceed what is left of the build's
 * {@link SERVER_SCAN_BUDGET}, every visible variable is hidden and true is
 * returned.
 */
function hideJointServerValues(
  template: string,
  names: string[],
  occurrences: Map<string, number>,
  hidden: Set<string>,
  candidates: (name: string) => string[],
  budget: { characters: number }
): boolean {
  const used = names.filter((name) => occurrences.has(name));
  for (;;) {
    const visible = used.filter((name) => !hidden.has(name));
    if (visible.length === 0) return false;
    const lists = used.map((name) => Array.from(new Set(candidates(name))));
    if (!template.includes("@") && lists.every((list) => list.every((value) => !/[@?#]/.test(value)))) return false;
    const count = lists.reduce((product, list) => product * list.length, 1);
    // An upper bound on each expansion: the template with every placeholder at its variable's longest value.
    const length = used.reduce((total, name, index) => total + occurrences.get(name)! * lists[index].reduce((longest, value) => Math.max(longest, value.length), 0), template.length);
    if (count > SERVER_COMBINATION_LIMIT || !chargeBudget(budget, count * length)) {
      visible.forEach((name) => hidden.add(name));
      return true;
    }
    let grew = false;
    for (let combination = 0; combination < count; combination += 1) {
      const values: Record<string, string> = {};
      let rest = combination;
      used.forEach((name, index) => {
        setOwn(values, name, lists[index][rest % lists[index].length]);
        rest = Math.floor(rest / lists[index].length);
      });
      const expansion = expandServerUrl(template, values);
      const parts = removedServerUrlSpans(expansion.text);
      for (const span of expansion.spans) {
        if (!hidden.has(span.name) && parts.some((part) => span.start < part.end && span.end > part.start)) {
          hidden.add(span.name);
          grew = true;
        }
      }
    }
    if (!grew) return false;
  }
}

/**
 * Escapes a component name for a `$ref` emitted into the catalog, so
 * {@link parseLocalRef} reads it back as that name (diagnostic pointers use pointerSegment).
 */
function refSegment(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1").replace(/%/g, "%25");
}

/** A reference for a message: a local one is a pointer, judged segment by segment so `~1~1` cannot hide URL user info. */
function showRef(ref: string): string {
  return ref.startsWith("#") ? `#${sanitizePointer(ref.slice(1))}` : redactWhole(ref);
}

/**
 * The reference tokens of a local `$ref`, read as RFC 6901 section 6 reads a
 * URI fragment: the whole fragment is percent-decoded, then split on "/",
 * then "~1" and "~0" are unescaped in each token. Every token counts, empty
 * ones included (`#/` is the member named ""). Null for a reference that is
 * not local or not a pointer, a malformed percent escape, or a "~" not
 * followed by 0 or 1. The single reader of local references.
 */
function parseLocalRef(ref: string): string[] | null {
  if (!ref.startsWith("#")) return null;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return null;
  }
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const tokens = pointer.slice(1).split("/");
  if (tokens.some((token) => /~(?![01])/.test(token))) return null;
  return tokens.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The diagnostic pointer of a local reference's target; the raw fragment for one {@link parseLocalRef} rejects. */
function refPointer(ref: string): string {
  const tokens = parseLocalRef(ref);
  return tokens ? tokens.map((token) => `/${pointerSegment(token)}`).join("") : sanitizePointer(ref.slice(1));
}

function resolvePointer(doc: Doc, ref: string): unknown {
  const tokens = parseLocalRef(ref);
  if (!tokens) return undefined;
  let current: unknown = doc;
  // Array indices are canonical (RFC 6901): no leading zeros.
  for (const segment of tokens) {
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Header names are case-insensitive; query and cookie names are not. */
function parameterKey(location: string, name: string): string {
  return `${location}:${location === "header" ? name.toLowerCase() : name}`;
}

function toIdentifier(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `op${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** Component name of a `#/components/schemas/<name>` reference; null for any other target, including nested pointers. */
function componentName(ref: string): string | null {
  const tokens = parseLocalRef(ref);
  if (tokens?.length !== 3 || tokens[0] !== "components" || tokens[1] !== "schemas" || tokens[2] === "") return null;
  return tokens[2];
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort(compareCodeUnits);
}

interface SpecOperation {
  method: HttpMethod;
  path: string;
  pointer: string;
  pathItem: Record<string, unknown>;
  pathItemPointer: string;
  operation: Record<string, unknown>;
  operationId: string | null;
}

/**
 * How a schema is reached: 0 plainly; 1 where it describes an instance that a
 * credential field could fill (another schema for the same instance reaches
 * one), so its literals are dropped; 2 from a credential field, so its
 * literals and unrecognized members are dropped.
 */
type Taint = 0 | 1 | 2;

class CatalogBuilder {
  readonly diagnostics: Diagnostic[] = [];
  /** While positive, reports are discarded: componentSchemas settles component taint in a dry run before emitting. */
  private muted = 0;
  /** Component schemas reached from operations, with the strongest {@link Taint} they are reached with. */
  private readonly componentRefs = new Map<string, Taint>();
  /** Component names whose entry in componentRefs is new or newly tainted, for componentSchemas to emit. */
  private readonly pendingComponents: string[] = [];
  /** The schema graph {@link reachesCredentialField} has explored, the schemas known to reach a credential field, and reverse edges. */
  private readonly reach = {
    explored: new Set<Record<string, unknown>>(),
    reaching: new Set<Record<string, unknown>>(),
    parents: new Map<Record<string, unknown>, Array<Record<string, unknown>>>(),
  };
  /** What is left of {@link SERVER_SCAN_BUDGET} for this build; servers are judged in a fixed order (paths sorted), so key order cannot change it. */
  private readonly serverScanBudget = { characters: SERVER_SCAN_BUDGET };
  /** The innermost schema being copied that declares a resource `$id`, against which JSON Schema resolves the references inside it. */
  private resource: { pointer: string } | null = null;
  private readonly mediaTypes: Set<string>;
  /** `<in>:<name>` of every parameter that a declared apiKey security scheme carries. */
  private readonly apiKeyParameters = new Set<string>();
  private readonly schemaComponents: Record<string, unknown>;
  private readonly declaredSchemes: Record<string, unknown>;

  constructor(
    private readonly doc: Doc,
    private readonly manifest: ApiManifest
  ) {
    this.mediaTypes = new Set((manifest.serialization?.mediaTypes ?? ["application/json"]).map(normalizeMediaType));
    const components = this.member(doc, "components", "", OBJECT) ?? {};
    this.schemaComponents = this.member(components, "schemas", "/components", OBJECT) ?? {};
    this.declaredSchemes = this.member(components, "securitySchemes", "/components", OBJECT) ?? {};
    for (const [name, value] of Object.entries(this.declaredSchemes)) {
      const scheme = this.deref(value, `/components/securitySchemes/${pointerSegment(name)}`)?.value;
      if (scheme?.type === "apiKey" && typeof scheme.in === "string" && typeof scheme.name === "string") {
        this.apiKeyParameters.add(parameterKey(scheme.in, scheme.name));
      }
    }
  }

  /**
   * The single credential-field predicate for parameters: a credential-like
   * name, or the location and name of a declared apiKey security scheme.
   */
  isCredentialParameter(location: string, name: string): boolean {
    return isCredentialKey(name) || this.apiKeyParameters.has(parameterKey(location, name));
  }

  report(
    code: Diagnostic["code"],
    pointer: string,
    message: string,
    options: { severity?: Diagnostic["severity"]; source?: Diagnostic["source"]; operation?: string } = {}
  ): void {
    if (this.muted > 0) return;
    this.diagnostics.push({
      code,
      severity: options.severity ?? "error",
      message,
      pointer,
      source: options.source ?? "spec",
      ...(options.operation ? { operation: options.operation } : {}),
    });
  }

  /**
   * Reads an optional member of an OpenAPI object. Absent is undefined; a
   * present value of the wrong type is INVALID_SPEC and also undefined, so a
   * malformed container or flag is never silently replaced by a default.
   */
  member<T>(owner: Record<string, unknown>, key: string, pointer: string, type: MemberType<T>, operation?: string): T | undefined {
    const value = own(owner, key);
    if (value === undefined || type.accepts(value)) return value as T | undefined;
    const at = `${pointer}/${pointerSegment(key)}`;
    this.report("INVALID_SPEC", at, `Expected ${type.name} at ${at}, found ${describeValue(value)}.`, { operation });
    return undefined;
  }

  /**
   * Copies author text. Text holding a recognizable credential is replaced
   * whole with `[REDACTED]`, so no part of the value survives however its end
   * is read. A present non-string is INVALID_SPEC.
   */
  text(value: unknown, pointer: string, source: Diagnostic["source"] = "spec"): string | null {
    if (value === undefined) return null;
    if (typeof value !== "string") {
      this.report("INVALID_SPEC", pointer, `Expected a string at ${pointer}, found ${describeValue(value)}.`, { source });
      return null;
    }
    if (!containsCredentialValue(value)) return value;
    this.report("CREDENTIAL_REDACTED", pointer, `Replaced the text at ${pointer}, which holds a credential-like value; credentials never belong in API descriptions.`, { severity: "warning", source });
    return REDACTED;
  }

  /**
   * Checks an identifier or map key (operationId, path, parameter, property,
   * scheme or scope name). These are copied verbatim into generated clients,
   * so a credential-like one is an error, never redacted.
   */
  identifier(value: string, pointer: string, what: string, operation?: string): string {
    if (containsCredentialIdentifier(value)) {
      this.report("INVALID_SPEC", pointer, `${what} at ${pointer} holds a credential-like value; identifiers are copied verbatim into generated clients, so rename it.`, { operation });
    }
    return value;
  }

  /** Copies a URL without user info, credential query parameters or fragment (`dropQuery` removes the whole query). */
  url(value: unknown, pointer: string, options: { source?: Diagnostic["source"]; dropQuery?: boolean } = {}): string | null {
    const source = options.source ?? "spec";
    if (typeof value !== "string") return this.text(value, pointer, source); // Reports a present non-string.
    if (isAmbiguousUrl(value)) {
      this.report(source === "manifest" ? "INVALID_MANIFEST" : "INVALID_SPEC", pointer, `The URL at ${pointer} has a "\\" before an "@" in its authority, so URL parsers disagree on its host; use "/" instead of "\\".`, { source });
      return REDACTED;
    }
    const stripped = stripUrlCredentials(value, { dropQuery: options.dropQuery });
    if (stripped !== value) {
      this.report("CREDENTIAL_REDACTED", pointer, `Removed user info, credential or query parameters, or the fragment from the URL at ${pointer}.`, { severity: "warning", source });
    }
    return this.text(stripped, pointer, source);
  }

  /**
   * Reports an external or dangling `$ref` on `value`. Returns true when
   * `value` is a reference, so OpenAPI Reference Objects stop the walk.
   */
  private checkRef(value: Record<string, unknown>, pointer: string, expect: "schema" | "object"): boolean {
    if (!Object.hasOwn(value, "$ref")) return false;
    const problem = this.refProblem(value.$ref, expect);
    if (problem) this.report("UNRESOLVED_REF", `${pointer}/$ref`, problem);
    return true;
  }

  /**
   * Why a `$ref` cannot be followed, or null. A target must exist and have
   * the expected type: an existence check alone would let a reference to
   * `null` or a string silently drop the referencing object.
   */
  private refProblem(ref: unknown, expect: "schema" | "object"): string | null {
    if (typeof ref !== "string") return "A $ref value must be a string.";
    const shown = showRef(ref);
    if (!ref.startsWith("#")) {
      return `External reference ${quote(shown)} is not supported; bundle external documents into the spec before building the catalog.`;
    }
    if (!parseLocalRef(ref)) {
      return `Reference ${quote(shown)} is not a JSON Pointer: after percent-decoding it must be empty or start with "/", every percent escape must be well-formed UTF-8, and every "~" must be followed by 0 or 1 (RFC 6901).`;
    }
    const target = resolvePointer(this.doc, ref);
    if (target === undefined) return `Reference ${quote(shown)} does not resolve to a value in the spec.`;
    if (isRecord(target) || (expect === "schema" && typeof target === "boolean")) return null;
    return `Reference ${quote(shown)} resolves to ${describeValue(target)}, not ${expect === "schema" ? "a Schema Object or boolean" : "an object"}.`;
  }

  private walkMap(value: unknown, pointer: string, walk: (entry: unknown, pointer: string) => void, skipExtensions = false): void {
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (!(skipExtensions && key.startsWith("x-"))) walk(entry, `${pointer}/${pointerSegment(key)}`);
    }
  }

  private walkList(value: unknown, pointer: string, walk: (entry: unknown, pointer: string) => void): void {
    if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${pointer}/${index}`));
  }

  /** Walks schema keywords only: property names are never keywords and literal data is never a reference. */
  private walkSchema(value: unknown, pointer: string): void {
    if (!isRecord(value)) return;
    this.checkRef(value, pointer, "schema");
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${pointerSegment(key)}`;
      if (SCHEMA_MAP_KEYWORDS.has(key)) this.walkMap(child, childPointer, (entry, entryPointer) => this.walkSchema(entry, entryPointer));
      else if (SCHEMA_KEYWORDS.has(key)) this.walkSchema(child, childPointer);
      else if (SCHEMA_LIST_KEYWORDS.has(key)) this.walkList(child, childPointer, (entry, entryPointer) => this.walkSchema(entry, entryPointer));
    }
  }

  private walkContent(value: unknown, pointer: string): void {
    this.walkMap(value, pointer, (media, mediaPointer) => {
      if (!isRecord(media)) return;
      this.walkSchema(media.schema, `${mediaPointer}/schema`);
      this.walkMap(media.encoding, `${mediaPointer}/encoding`, (encoding, encodingPointer) => {
        if (isRecord(encoding)) this.walkMap(encoding.headers, `${encodingPointer}/headers`, (header, headerPointer) => this.walkParameter(header, headerPointer));
      });
    });
  }

  /** Parameter and Header Objects. */
  private walkParameter(value: unknown, pointer: string): void {
    if (!isRecord(value) || this.checkRef(value, pointer, "object")) return;
    this.walkSchema(value.schema, `${pointer}/schema`);
    this.walkContent(value.content, `${pointer}/content`);
  }

  private walkRequestBody(value: unknown, pointer: string): void {
    if (isRecord(value) && !this.checkRef(value, pointer, "object")) this.walkContent(value.content, `${pointer}/content`);
  }

  private walkResponse(value: unknown, pointer: string): void {
    if (!isRecord(value) || this.checkRef(value, pointer, "object")) return;
    this.walkMap(value.headers, `${pointer}/headers`, (header, headerPointer) => this.walkParameter(header, headerPointer));
    this.walkContent(value.content, `${pointer}/content`);
  }

  private walkCallback(value: unknown, pointer: string): void {
    if (isRecord(value) && !this.checkRef(value, pointer, "object")) {
      this.walkMap(value, pointer, (item, itemPointer) => this.walkPathItem(item, itemPointer), true);
    }
  }

  /** A Path Item `$ref` is a Path Item field, not a Reference Object: the fields beside it are walked too. */
  private walkPathItem(value: unknown, pointer: string): void {
    if (!isRecord(value)) return;
    this.checkRef(value, pointer, "object");
    this.walkList(value.parameters, `${pointer}/parameters`, (parameter, parameterPointer) => this.walkParameter(parameter, parameterPointer));
    for (const method of METHODS) {
      const operation = own(value, method);
      if (!isRecord(operation)) continue;
      const operationPointer = `${pointer}/${method}`;
      this.walkList(operation.parameters, `${operationPointer}/parameters`, (parameter, parameterPointer) => this.walkParameter(parameter, parameterPointer));
      this.walkRequestBody(operation.requestBody, `${operationPointer}/requestBody`);
      this.walkMap(operation.responses, `${operationPointer}/responses`, (response, responsePointer) => this.walkResponse(response, responsePointer), true);
      this.walkMap(operation.callbacks, `${operationPointer}/callbacks`, (callback, callbackPointer) => this.walkCallback(callback, callbackPointer));
    }
  }

  /**
   * Checks every reference by OpenAPI context: map keys such as property,
   * header or component names are never mistaken for keywords, and examples,
   * extensions and literal schema data are never treated as references.
   */
  checkRefs(): void {
    this.walkMap(this.doc.paths, "/paths", (item, pointer) => this.walkPathItem(item, pointer), true);
    this.walkMap(this.doc.webhooks, "/webhooks", (item, pointer) => this.walkPathItem(item, pointer));
    const components = this.doc.components;
    if (!isRecord(components)) return;
    const walkers: Record<string, (entry: unknown, pointer: string) => void> = {
      schemas: (entry, pointer) => this.walkSchema(entry, pointer),
      parameters: (entry, pointer) => this.walkParameter(entry, pointer),
      headers: (entry, pointer) => this.walkParameter(entry, pointer),
      requestBodies: (entry, pointer) => this.walkRequestBody(entry, pointer),
      responses: (entry, pointer) => this.walkResponse(entry, pointer),
      pathItems: (entry, pointer) => this.walkPathItem(entry, pointer),
      callbacks: (entry, pointer) => this.walkCallback(entry, pointer),
      securitySchemes: (entry, pointer) => void (isRecord(entry) && this.checkRef(entry, pointer, "object")),
    };
    for (const [section, walk] of Object.entries(walkers)) {
      this.walkMap(own(components, section), `/components/${section}`, walk);
    }
  }

  /**
   * Follows Reference Objects to an OpenAPI object. Undefined means absent;
   * anything else that is not an object is reported, never dropped silently
   * (the reference diagnostic matches checkRefs, so the two deduplicate).
   */
  deref(value: unknown, pointer: string, pathItem = false): { value: Record<string, unknown>; pointer: string } | null {
    if (value === undefined) return null;
    if (!isRecord(value)) {
      this.report("INVALID_SPEC", pointer, `Expected an object at ${pointer}, found ${describeValue(value)}.`);
      return null;
    }
    let current: Record<string, unknown> = value;
    let currentPointer = pointer;
    for (let hops = 0; hops < 32; hops += 1) {
      if (!Object.hasOwn(current, "$ref")) return { value: current, pointer: currentPointer };
      if (pathItem) this.pathItemRefFields(current, currentPointer);
      const problem = this.refProblem(current.$ref, "object");
      if (problem) {
        this.report("UNRESOLVED_REF", `${currentPointer}/$ref`, problem);
        return null;
      }
      const ref = current.$ref as string;
      currentPointer = refPointer(ref);
      current = resolvePointer(this.doc, ref) as Record<string, unknown>;
    }
    this.report("UNRESOLVED_REF", pointer, `Reference chain at ${pointer} is cyclic or longer than 32 hops.`);
    return null;
  }

  /**
   * A Path Item `$ref` is a Path Item field, so the fields beside it are Path
   * Item fields too; OpenAPI leaves their merge with the referenced path item
   * undefined. The catalog does not merge them, so any field beside the
   * `$ref` other than summary, description and `x-*` is an error, never dropped.
   */
  private pathItemRefFields(value: Record<string, unknown>, pointer: string): void {
    const fields = Object.keys(value).filter((key) => key !== "$ref" && key !== "summary" && key !== "description" && !key.startsWith("x-"));
    if (fields.length === 0) return;
    const target = typeof value.$ref === "string" ? showRef(value.$ref) : "";
    this.report(
      "INVALID_SPEC",
      pointer,
      `Path Item at ${pointer} has ${fields.sort(compareCodeUnits).map(quote).join(", ")} beside its $ref; the catalog does not merge Path Item fields. Move them into the referenced path item ${quote(target)}.`
    );
  }

  /**
   * Copies a schema without examples or extensions. Inside a credential field
   * (a credential parameter or property, `format: password`, or any
   * subschema, applicator or component reached from one) literal values and
   * unrecognized members are dropped. Members holding credential-named keys
   * are dropped everywhere. A literal or unrecognized member is also dropped when the instance it
   * describes could hold a credential field's value: when this schema, or
   * any schema for the same instance (`sameInstance`: an `allOf`, `anyOf` or
   * `oneOf` sibling, a `$ref` target, transitively), reaches one. Other
   * literal data is copied verbatim.
   */
  schema(value: unknown, pointer: string, credential = false, sameInstance = false): JsonValue | null {
    const outer = this.resource;
    const id = isRecord(value) ? value.$id : undefined;
    if (typeof id === "string" && /#./s.test(id)) {
      this.report("INVALID_SPEC", `${pointer}/$id`, `The $id at ${pointer}/$id has a non-empty fragment, which JSON Schema 2020-12 forbids; name the schema with $anchor instead.`);
    } else if (typeof id === "string" && id !== "" && id !== "#") {
      // "" and "#" (an empty fragment) resolve to the document itself, so they start no resource.
      this.resource = { pointer };
    }
    try {
      return this.schemaObject(value, pointer, credential, sameInstance);
    } finally {
      this.resource = outer;
    }
  }

  private schemaObject(value: unknown, pointer: string, credential: boolean, sameInstance: boolean): JsonValue | null {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (!isRecord(value)) {
      this.report("INVALID_SPEC", pointer, `Expected a Schema Object or boolean at ${pointer}, found ${describeValue(value)}.`);
      return null;
    }
    const secret = credential || value.format === "password";
    // Computed once per schema and only when needed; reachesCredentialField is linear over a whole build.
    let reaches: boolean | undefined;
    const instanceReaches = () => (reaches ??= sameInstance || this.reachesCredentialField(value));
    const taint = (): Taint => (secret ? 2 : instanceReaches() ? 1 : 0);
    const output: Record<string, JsonValue> = {};
    const drop = (key: string, childPointer: string, reason: string) =>
      this.report("CREDENTIAL_REDACTED", childPointer, `Dropped ${quote(key)} at ${childPointer} because ${reason}.`, { severity: "warning" });
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${pointerSegment(key)}`;
      if (key === "example" || key === "examples" || key.startsWith("x-")) continue;
      const expected = SCHEMA_KEYWORD_TYPES.get(key);
      if (expected && !expected.accepts(child)) {
        this.report("INVALID_SPEC", childPointer, `Expected ${expected.name} at ${childPointer}, found ${describeValue(child)}.`);
      } else if (isCredentialMember(key)) {
        drop(key, childPointer, "its name is or holds a credential");
      } else if (REFERENCE_KEYWORDS.has(key) && this.resource) {
        // The catalog resolves every reference against the document; inside a resource JSON Schema would not.
        // The $id is named by its pointer, not its value, so many references cannot repeat a long one.
        this.report("UNRESOLVED_REF", childPointer, `Reference at ${childPointer} lies inside the schema resource declared at ${this.resource.pointer}/$id, where JSON Schema resolves it against that $id rather than this document; remove the $id or move the reference out of that schema.`);
      } else if (REFERENCE_KEYWORDS.has(key)) {
        const ref = this.schemaRef(child, childPointer, taint());
        if (ref !== null) setOwn(output, key, ref);
      } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
        if (!isRecord(child)) {
          this.report("INVALID_SPEC", childPointer, `Expected an object of schemas at ${childPointer}, found ${describeValue(child)}.`);
          continue;
        }
        const entries: Record<string, JsonValue> = {};
        const named = key === "properties" || key === "patternProperties";
        for (const [name, entry] of Object.entries(child)) {
          this.identifier(name, `${childPointer}/${pointerSegment(name)}`, "Schema member name");
          const nested = this.schema(entry, `${childPointer}/${pointerSegment(name)}`, secret || (named && isCredentialKey(name)), SAME_INSTANCE_KEYWORDS.has(key) && instanceReaches());
          if (nested !== null) setOwn(entries, name, nested);
        }
        setOwn(output, key, entries);
      } else if (SCHEMA_KEYWORDS.has(key)) {
        const nested = this.schema(child, childPointer, secret, SAME_INSTANCE_KEYWORDS.has(key) && instanceReaches());
        if (nested !== null) setOwn(output, key, nested);
      } else if (SCHEMA_LIST_KEYWORDS.has(key)) {
        if (Array.isArray(child)) {
          const same = SAME_INSTANCE_KEYWORDS.has(key) && instanceReaches();
          setOwn(output, key, child.map((entry, index) => this.schema(entry, `${childPointer}/${index}`, secret, same) ?? {}));
        }
        else this.report("INVALID_SPEC", childPointer, `Expected an array of schemas at ${childPointer}, found ${describeValue(child)}.`);
      } else if (key === "discriminator") {
        if (isRecord(child)) setOwn(output, key, this.discriminator(child, childPointer, taint()));
        else this.report("INVALID_SPEC", childPointer, `Expected a Discriminator Object at ${childPointer}, found ${describeValue(child)}.`);
      } else if (key === "pattern" && secret) {
        // A pattern can spell the credential in any regex syntax (`^(x)$`, `^x{1}$`, `^x|x$`), so a credential field carries none.
        drop(key, childPointer, "a credential field carries no pattern; any pattern there can spell the credential");
      } else if (key === "pattern" && typeof child === "string") {
        // A regular expression, not author text: redaction would change its meaning, so a credential-bearing one is dropped.
        if (containsCredentialValue(patternLiterals(child))) drop(key, childPointer, "the pattern holds a credential-like value");
        else setOwn(output, key, child);
      } else if (key === "required") {
        if (STRING_LIST.accepts(child)) setOwn(output, key, this.names(child, childPointer));
        else this.report("INVALID_SPEC", childPointer, `Expected an array of property names at ${childPointer}, found ${describeValue(child)}.`);
      } else if (NAME_KEYWORDS.has(key)) {
        if (isRecord(child) && Object.values(child).every((names) => STRING_LIST.accepts(names))) {
          const entries: Record<string, JsonValue> = {};
          for (const [name, names] of Object.entries(child)) {
            const namePointer = `${childPointer}/${pointerSegment(name)}`;
            setOwn(entries, this.identifier(name, namePointer, "Property name"), this.names(names as string[], namePointer));
          }
          setOwn(output, key, entries);
        } else {
          this.report("INVALID_SPEC", childPointer, `Expected an object of property-name arrays at ${childPointer}.`);
        }
      } else if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof child === "boolean") {
        // The OpenAPI 3.0 (JSON Schema draft 4) form qualifies `minimum`/`maximum`; in the catalog's 2020-12 the bound itself
        // is exclusive. `false`, or `true` without a numeric bound, says nothing and is dropped.
        const bound = own(value, key === "exclusiveMinimum" ? "minimum" : "maximum");
        if (child && typeof bound === "number") setOwn(output, key, bound);
      } else if ((key === "minimum" || key === "maximum") && own(value, `exclusive${key[0].toUpperCase()}${key.slice(1)}`) === true && typeof child === "number") {
        continue; // Emitted as the exclusive bound.
      } else if (secret && !CREDENTIAL_FIELD_KEYWORDS.has(key)) {
        drop(key, childPointer, "it is literal or unrecognized data inside a credential field");
      } else if (!CREDENTIAL_FIELD_KEYWORDS.has(key) && instanceReaches()) {
        // Literals and unrecognized members alike: an unrecognized member could hold a default under another name.
        drop(key, childPointer, "the schema, or a schema for the same instance, contains a credential field whose value the literal or unrecognized member would carry");
      } else if (key === "enum" && Array.isArray(child) ? child.some(hasCredentialKey) : hasCredentialKey(child)) {
        // An enum lists values, so it is judged member by member: ["password", "otp"] lists two methods, not a pair.
        drop(key, childPointer, "it holds credential-named keys or a value named as a credential");
      } else {
        setOwn(output, key, this.data(OBJECT_KEYWORDS.has(key) ? withoutExtensions(child) : child, childPointer));
      }
    }
    return output;
  }

  /**
   * True when a subschema (through any schema keyword, applicator or component
   * `$ref`, not the schema itself) is a credential field: a credential-named
   * property or `format: password`. A literal on such a schema could carry
   * that field's value, as `default: {pin: "..."}` does for a password `pin`.
   *
   * Iterative, and linear over a whole build: the schemas reachable from
   * `schema` that no earlier call explored are explored once, then whether
   * each reaches a credential field is propagated back along their edges, so
   * long `$ref` chains and cycles neither recurse nor get walked twice.
   */
  private reachesCredentialField(schema: Record<string, unknown>): boolean {
    const { explored, reaching, parents } = this.reach;
    const fresh: Array<Record<string, unknown>> = [];
    const sources: Array<Record<string, unknown>> = [];
    const stack = [schema];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (explored.has(node)) continue;
      explored.add(node);
      fresh.push(node);
      let source = false;
      const edge = (child: unknown) => {
        if (!isRecord(child)) return;
        // A child already known to reach one (from an earlier call) or that is a password field makes this one reach.
        if (child.format === "password" || reaching.has(child)) source = true;
        const list = parents.get(child);
        if (list) list.push(node);
        else parents.set(child, [node]);
        if (!explored.has(child)) stack.push(child);
      };
      for (const [key, child] of Object.entries(node)) {
        if (REFERENCE_KEYWORDS.has(key)) {
          if (typeof child === "string" && child.startsWith("#")) edge(resolvePointer(this.doc, child));
        } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(child)) {
          const named = key === "properties" || key === "patternProperties";
          for (const [name, entry] of Object.entries(child)) {
            if (named && isCredentialKey(name)) source = true;
            edge(entry);
          }
        } else if (SCHEMA_KEYWORDS.has(key)) {
          edge(child);
        } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(child)) {
          child.forEach(edge);
        }
      }
      if (source) sources.push(node);
    }
    // Schemas explored by earlier calls are settled: everything they reach was explored with them.
    const isFresh = new Set(fresh);
    while (sources.length > 0) {
      const node = sources.pop()!;
      if (reaching.has(node)) continue;
      reaching.add(node);
      for (const parent of parents.get(node) ?? []) if (isFresh.has(parent) && !reaching.has(parent)) sources.push(parent);
    }
    return reaching.has(schema);
  }

  /** Property names (`required`, `dependentRequired`): checked like property names and copied verbatim, never rewritten. */
  private names(values: string[], pointer: string): string[] {
    return values.map((name, index) => this.identifier(name, `${pointer}/${index}`, "Property name"));
  }

  /**
   * Checks and records a schema reference that will be emitted, and returns
   * it in normal form: `#/components/schemas/<name>` with the name escaped
   * only by JSON Pointer rules, so `catalog.schemas[<name>]` resolves it.
   * Every emitted reference is checked here, wherever it was reached from (a
   * parameter behind `#/x-param` is never walked by checkRefs), so a
   * successful catalog has no dangling reference. Only component schemas can
   * be shared by generated clients. Returns null when the reference is unusable.
   */
  private schemaRef(ref: unknown, pointer: string, taint: Taint): string | null {
    const problem = this.refProblem(ref, "schema");
    if (problem) {
      this.report("UNRESOLVED_REF", pointer, problem);
      return null;
    }
    const name = componentName(ref as string);
    if (name === null) {
      this.report("UNRESOLVED_REF", pointer, `Schema reference ${quote(showRef(ref as string))} must target ${COMPONENT_SCHEMA_PREFIX}<name> so generated clients can share the type.`);
      return null;
    }
    this.referComponent(name, taint);
    return `${COMPONENT_SCHEMA_PREFIX}${refSegment(name)}`;
  }

  /** Records a reference to component schema `name`, queueing it for componentSchemas when it is new or newly reached with a stronger taint. */
  private referComponent(name: string, taint: Taint): void {
    const before = this.componentRefs.get(name);
    if (before !== undefined && before >= taint) return;
    this.componentRefs.set(name, taint);
    this.pendingComponents.push(name);
  }

  /**
   * Copies a Discriminator Object. Every mapping target must be a component
   * schema (by name or `#/components/schemas/<name>`); targets are emitted as
   * references and the schemas they name join the catalog.
   */
  private discriminator(value: Record<string, unknown>, pointer: string, taint: Taint): JsonValue {
    const output: Record<string, JsonValue> = {};
    const propertyName = this.member(value, "propertyName", pointer, STRING);
    if (propertyName !== undefined) output.propertyName = this.identifier(propertyName, `${pointer}/propertyName`, "Discriminator property name");
    const mapping = this.member(value, "mapping", pointer, OBJECT);
    if (mapping === undefined) return output;
    const targets: Record<string, JsonValue> = {};
    for (const key of Object.keys(mapping).sort(compareCodeUnits)) {
      const target = mapping[key];
      const targetPointer = `${pointer}/mapping/${pointerSegment(key)}`;
      this.identifier(key, targetPointer, "Discriminator mapping value");
      const name = typeof target !== "string" ? null : target.startsWith("#") ? componentName(target) : target;
      if (name === null || !Object.hasOwn(this.schemaComponents, name)) {
        const shown = typeof target === "string" ? showRef(target) : describeValue(target);
        this.report("UNRESOLVED_REF", targetPointer, `Discriminator mapping ${quote(key)} targets ${quote(shown)}, which is not a schema in ${COMPONENT_SCHEMA_PREFIX}<name>.`);
        continue;
      }
      this.referComponent(name, taint);
      setOwn(targets, key, `${COMPONENT_SCHEMA_PREFIX}${refSegment(name)}`);
    }
    output.mapping = targets;
    return output;
  }

  /** Copies literal JSON data verbatim, redacting credential-like strings. */
  data(value: unknown, pointer: string): JsonValue {
    if (typeof value === "string") return this.text(value, pointer) ?? "";
    if (Array.isArray(value)) return value.map((item, index) => this.data(item, `${pointer}/${index}`));
    if (isRecord(value)) {
      const output: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) {
        const childPointer = `${pointer}/${pointerSegment(key)}`;
        setOwn(output, this.identifier(key, childPointer, "Key"), this.data(child, childPointer));
      }
      return output;
    }
    return value === undefined ? null : (value as JsonValue);
  }

  encoding(media: Record<string, unknown>, pointer: string, mediaType: string, operation: string): Record<string, CatalogEncoding> {
    const output: Record<string, CatalogEncoding> = {};
    const encodings = this.member(media, "encoding", pointer, OBJECT, operation);
    if (!FORM_MEDIA_TYPES.has(mediaType) || encodings === undefined) return output;
    for (const name of Object.keys(encodings).sort(compareCodeUnits)) {
      const encoding = encodings[name];
      const encodingPointer = `${pointer}/encoding/${pointerSegment(name)}`;
      this.identifier(name, encodingPointer, "Encoding property name", operation);
      if (!isRecord(encoding)) {
        this.report("INVALID_SPEC", encodingPointer, `Encoding of property ${quote(name)} in operation ${quote(operation)} must be an Encoding Object.`, { operation });
        continue;
      }
      const style = this.member(encoding, "style", encodingPointer, STRING, operation) ?? "form";
      if (!PARAMETER_STYLES.query.includes(style)) {
        this.report("UNSUPPORTED_SERIALIZATION", `${encodingPointer}/style`, `Property ${quote(name)} of ${mediaType} in operation ${quote(operation)} uses style ${quote(style)}; supported styles are ${PARAMETER_STYLES.query.join(", ")}.`, { operation });
        continue;
      }
      if (encoding.headers !== undefined) {
        this.report("UNSUPPORTED_SERIALIZATION", `${encodingPointer}/headers`, `Part headers of property ${quote(name)} in operation ${quote(operation)} are not described in the catalog; generated clients will not send them.`, { severity: "warning", operation });
      }
      setOwn(output, name, {
        contentType: this.text(own(encoding, "contentType"), `${encodingPointer}/contentType`),
        style,
        explode: this.member(encoding, "explode", encodingPointer, BOOLEAN, operation) ?? style === "form",
        allowReserved: this.member(encoding, "allowReserved", encodingPointer, BOOLEAN, operation) ?? false,
      });
    }
    return output;
  }

  contents(content: unknown, pointer: string, operation: string, what: string): CatalogContent[] {
    if (content === undefined) return [];
    if (!isRecord(content)) {
      this.report("INVALID_SPEC", pointer, `${what} of operation ${quote(operation)} needs an object of media types at ${pointer}, found ${describeValue(content)}.`, { operation });
      return [];
    }
    const byType = new Map<string, { rawType: string; content: CatalogContent }>();
    const unsupported: string[] = [];
    // Source keys are visited in code-unit order so collisions resolve the same way for any key order.
    for (const rawType of Object.keys(content).sort(compareCodeUnits)) {
      const mediaType = normalizeMediaType(rawType);
      if (!this.mediaTypes.has(mediaType) || mediaTypeParameters(rawType).length > 0) {
        unsupported.push(rawType);
        continue;
      }
      const media = content[rawType];
      const mediaPointer = `${pointer}/${pointerSegment(rawType)}`;
      if (!isRecord(media)) {
        this.report("INVALID_SPEC", mediaPointer, `${what} of operation ${quote(operation)} describes ${redactWhole(rawType)} with ${describeValue(media)} instead of a Media Type Object.`, { operation });
        continue;
      }
      const entry: CatalogContent = { mediaType, schema: this.schema(own(media, "schema"), `${mediaPointer}/schema`), encoding: this.encoding(media, mediaPointer, mediaType, operation) };
      const existing = byType.get(mediaType);
      if (!existing) {
        byType.set(mediaType, { rawType, content: entry });
      } else if (canonicalJson(existing.content) !== canonicalJson(entry)) {
        this.report(
          "UNSUPPORTED_SERIALIZATION",
          mediaPointer,
          `${what} of operation ${quote(operation)} describes ${quote(existing.rawType)} and ${quote(rawType)} differently, but both are ${mediaType} to clients; keep one description per media type.`,
          { operation }
        );
      }
    }
    if (unsupported.length > 0) {
      const allowed = sortStrings(this.mediaTypes).join(", ");
      const listable = unsupported.filter((rawType) => isSupportedMediaType(normalizeMediaType(rawType)) && mediaTypeParameters(rawType).length === 0);
      // Only media types the catalog can describe may be added to the manifest; others need a spec change.
      const parameterized = unsupported.some((rawType) => mediaTypeParameters(rawType).length > 0)
        ? " (media type parameters other than charset=utf-8 change the bytes on the wire and are not supported)"
        : "";
      const advice = listable.length > 0
        ? `add a media type the manifest lists (${allowed}) or add ${sortStrings(listable.map(normalizeMediaType)).join(", ")} to manifest serialization.mediaTypes`
        : `the catalog cannot describe ${unsupported.map(redactWhole).join(", ")}, so the spec must also offer one of ${allowed}`;
      this.report(
        "UNSUPPORTED_SERIALIZATION",
        pointer,
        byType.size === 0
          ? `${what} of operation ${quote(operation)} only offers ${unsupported.map(redactWhole).join(", ")}${parameterized}; ${advice}.`
          : `${what} of operation ${quote(operation)} drops unsupported media types ${unsupported.map(redactWhole).join(", ")}${parameterized}; clients use ${allowed}.`,
        { severity: byType.size === 0 ? "error" : "warning", operation }
      );
    }
    return Array.from(byType.values(), (value) => value.content).sort((a, b) => compareCodeUnits(a.mediaType, b.mediaType));
  }

  parameters(entry: SpecOperation, id: string): CatalogParameter[] {
    const merged = new Map<string, { value: Record<string, unknown>; pointer: string }>();
    const sources: Array<[unknown, string]> = [
      [entry.pathItem.parameters, `${entry.pathItemPointer}/parameters`],
      [entry.operation.parameters, `${entry.pointer}/parameters`],
    ];
    for (const [list, pointer] of sources) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        this.report("INVALID_SPEC", pointer, `Parameters at ${pointer} of operation ${quote(id)} must be an array.`, { operation: id });
        continue;
      }
      // Header names are case-insensitive: X-A and x-a are one parameter, and the operation level wins.
      const level = new Set<string>();
      list.forEach((raw, index) => {
        const resolved = this.deref(raw, `${pointer}/${index}`);
        if (!resolved) return; // deref reported why.
        const { name, in: location } = resolved.value;
        if (typeof name !== "string" || name === "" || !PARAMETER_LOCATIONS.includes(location as CatalogParameter["in"])) {
          this.report("INVALID_SPEC", resolved.pointer, `Parameter at ${resolved.pointer} of operation ${quote(id)} needs a name and an "in" of ${PARAMETER_LOCATIONS.join(", ")}.`, { operation: id });
          return;
        }
        this.identifier(name, `${resolved.pointer}/name`, "Parameter name", id);
        const key = parameterKey(location as string, name);
        if (level.has(key)) {
          this.report("INVALID_SPEC", `${pointer}/${index}`, `Parameter ${quote(name)} in ${location} is declared twice at ${pointer} of operation ${quote(id)}${location === "header" ? " (header names are case-insensitive)" : ""}.`, { operation: id });
          return;
        }
        level.add(key);
        merged.set(key, resolved);
      });
    }

    const template = Array.from(entry.path.matchAll(/\{([^}]+)\}/g), (match) => match[1]);
    const parameters: CatalogParameter[] = [];
    for (const { value, pointer } of merged.values()) {
      const location = value.in as CatalogParameter["in"];
      const name = value.name as string;
      if (location === "path" && !template.includes(name)) {
        this.report("INVALID_SPEC", pointer, `Path parameter ${quote(name)} of operation ${quote(id)} is declared but does not appear in the path template ${redactWhole(entry.path)}.`, { operation: id });
        continue;
      }
      if (location === "header" && IGNORED_HEADERS.has(name.toLowerCase())) continue;
      const style = this.member(value, "style", pointer, STRING, id) ?? (location === "query" || location === "cookie" ? "form" : "simple");
      if (value.content !== undefined || !PARAMETER_STYLES[location].includes(style)) {
        this.report(
          "UNSUPPORTED_SERIALIZATION",
          pointer,
          value.content !== undefined
            ? `Parameter ${quote(name)} of operation ${quote(id)} uses content-based serialization; describe it with a schema instead.`
            : `Parameter ${quote(name)} of operation ${quote(id)} uses style ${quote(style)}; supported ${location} styles are ${PARAMETER_STYLES[location].join(", ")}.`,
          { operation: id }
        );
        continue;
      }
      const required = this.member(value, "required", pointer, BOOLEAN, id) ?? false;
      parameters.push({
        name,
        in: location,
        required: location === "path" ? true : required,
        deprecated: this.member(value, "deprecated", pointer, BOOLEAN, id) ?? false,
        style,
        explode: this.member(value, "explode", pointer, BOOLEAN, id) ?? style === "form",
        allowReserved: this.member(value, "allowReserved", pointer, BOOLEAN, id) ?? false,
        description: this.text(own(value, "description"), `${pointer}/description`),
        schema: this.schema(own(value, "schema"), `${pointer}/schema`, this.isCredentialParameter(location, name)),
      });
    }
    // Path parameters keep template order so generated clients get stable positional arguments.
    for (const name of template) {
      if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name)) {
        this.report("INVALID_SPEC", entry.pointer, `Path parameter ${quote(name)} of operation ${quote(id)} appears in the path template but is not declared.`, { operation: id });
      }
    }
    const rank = (parameter: CatalogParameter) =>
      parameter.in === "path" ? template.indexOf(parameter.name) : template.length + PARAMETER_LOCATIONS.indexOf(parameter.in);
    return parameters.sort((a, b) => rank(a) - rank(b) || compareCodeUnits(a.name, b.name));
  }

  responses(entry: SpecOperation, id: string): CatalogResponse[] {
    const responses = this.member(entry.operation, "responses", entry.pointer, OBJECT, id);
    if (responses === undefined) return [];
    return Object.keys(responses)
      .sort(compareCodeUnits)
      .flatMap((status) => {
        if (status.startsWith("x-")) return [];
        if (!RESPONSE_STATUS.test(status)) {
          this.report("INVALID_SPEC", `${entry.pointer}/responses/${pointerSegment(status)}`, `Response key ${quote(status)} of operation ${quote(id)} is not an HTTP status, a 1XX-5XX range or "default".`, { operation: id });
          return [];
        }
        const resolved = this.deref(responses[status], `${entry.pointer}/responses/${pointerSegment(status)}`);
        if (!resolved) return [];
        const kind: CatalogResponse["kind"] = status === "default" ? "default" : /^[45]/.test(status) ? "error" : "success";
        const headers = this.member(resolved.value, "headers", resolved.pointer, OBJECT, id);
        // Header names are not extensions (`x-ratelimit-remaining` is a header); OpenAPI ignores Content-Type here.
        if (headers && Object.keys(headers).some((name) => name.toLowerCase() !== "content-type")) {
          this.report("UNSUPPORTED_SERIALIZATION", `${resolved.pointer}/headers`, `Response ${status} headers of operation ${quote(id)} are not described in the catalog; generated clients will not expose them.`, { severity: "warning", operation: id });
        }
        return [
          {
            status,
            kind,
            description: this.text(own(resolved.value, "description"), `${resolved.pointer}/description`) ?? "",
            contents: this.contents(own(resolved.value, "content"), `${resolved.pointer}/content`, id, `Response ${status}`),
          },
        ];
      });
  }

  /**
   * Security alternatives (OR of ANDs). Malformed declarations are errors,
   * never anonymous access or empty scopes: only an explicit `{}` requirement
   * (or `security: []`) means anonymous.
   */
  security(entry: SpecOperation, id: string): SecurityRequirementTerm[][] {
    const operationLevel = entry.operation.security !== undefined;
    const declared = operationLevel ? entry.operation.security : this.doc.security;
    const pointer = operationLevel ? `${entry.pointer}/security` : "/security";
    const schemes = this.declaredSchemes;
    const invalid = (at: string, message: string) => this.report("INVALID_SPEC", at, message, { operation: id });
    if (declared !== undefined && !Array.isArray(declared)) {
      invalid(pointer, `Security of operation ${quote(id)} at ${pointer} must be an array of security requirement objects.`);
      return [[]];
    }
    const alternatives = new Map<string, SecurityRequirementTerm[]>();
    (declared ?? []).forEach((requirement: unknown, index: number) => {
      const requirementPointer = `${pointer}/${index}`;
      if (!isRecord(requirement)) {
        invalid(requirementPointer, `Security requirement ${requirementPointer} of operation ${quote(id)} must be an object of scheme names to scope arrays; use {} for anonymous access.`);
        return;
      }
      const terms: SecurityRequirementTerm[] = [];
      for (const scheme of Object.keys(requirement).sort(compareCodeUnits)) {
        const schemePointer = `${requirementPointer}/${pointerSegment(scheme)}`;
        this.identifier(scheme, schemePointer, "Security scheme name", id);
        if (!Object.hasOwn(schemes, scheme)) {
          this.report("UNKNOWN_SECURITY_SCHEME", schemePointer, `Operation ${quote(id)} requires security scheme ${quote(scheme)}, which is not declared in components.securitySchemes.`, { operation: id });
        }
        const scopes = requirement[scheme];
        if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
          invalid(schemePointer, `Scopes of security scheme ${quote(scheme)} in operation ${quote(id)} must be an array of strings; use [] for none.`);
          continue;
        }
        terms.push({ scheme, scopes: sortStrings(scopes.map((scope: string, scopeIndex) => this.identifier(scope, `${schemePointer}/${scopeIndex}`, "Scope name", id))) });
      }
      alternatives.set(canonicalJson(terms), terms);
    });
    if (alternatives.size === 0) return [[]];
    return Array.from(alternatives.keys())
      .sort(compareCodeUnits)
      .map((key) => alternatives.get(key) as SecurityRequirementTerm[]);
  }

  operation(entry: SpecOperation, binding: OperationBinding): CatalogOperation {
    const op = entry.operation;
    const deprecated = (this.member(op, "deprecated", entry.pointer, BOOLEAN, binding.id) ?? false) || binding.deprecation !== undefined;
    const requestBody = this.deref(op.requestBody, `${entry.pointer}/requestBody`);
    const bindingPointer = `/operations/${this.manifest.operations.indexOf(binding)}`;
    const name = binding.name ?? toIdentifier(entry.operationId ?? binding.id);
    if (name.length > NAME_MAX_LENGTH) {
      this.report("INVALID_MANIFEST", `${bindingPointer}/name`, `Name "${redactWhole(name).slice(0, 32)}…" derived for operation ${quote(binding.id)} has ${name.length} characters; catalog names allow ${NAME_MAX_LENGTH}, so set a shorter manifest name.`, { source: "manifest", operation: binding.id });
    }
    const tags = this.member(op, "tags", entry.pointer, LIST, binding.id) ?? [];
    // A malformed operation-level list is reported and never falls back to the path item's servers.
    const operationServers = this.member(op, "servers", entry.pointer, LIST, binding.id);
    const pathServers = own(op, "servers") === undefined ? this.member(entry.pathItem, "servers", entry.pathItemPointer, LIST, binding.id) : undefined;
    tags.forEach((tag, index) => {
      if (typeof tag !== "string") this.report("INVALID_SPEC", `${entry.pointer}/tags/${index}`, `Tag ${index} of operation ${quote(binding.id)} must be a string.`, { operation: binding.id });
    });
    return {
      id: binding.id,
      name,
      openapiOperationId: entry.operationId,
      method: entry.method,
      path: entry.path,
      summary: this.text(own(op, "summary"), `${entry.pointer}/summary`),
      description: this.text(own(op, "description"), `${entry.pointer}/description`),
      tags: sortStrings(tags.flatMap((tag, index) => (typeof tag === "string" ? [this.text(tag, `${entry.pointer}/tags/${index}`) as string] : []))),
      parameters: this.parameters(entry, binding.id),
      requestBody: requestBody
        ? {
            required: this.member(requestBody.value, "required", requestBody.pointer, BOOLEAN, binding.id) ?? false,
            contents: this.contents(own(requestBody.value, "content"), `${requestBody.pointer}/content`, binding.id, "Request body"),
          }
        : null,
      responses: this.responses(entry, binding.id),
      servers: operationServers
        ? this.servers(operationServers, `${entry.pointer}/servers`)
        : pathServers
          ? this.servers(pathServers, `${entry.pathItemPointer}/servers`)
          : null,
      security: { alternatives: this.security(entry, binding.id) },
      sdk: {
        include: binding.sdk?.include ?? true,
        excludedTargets: sortStrings(binding.sdk?.excludeTargets ?? []),
      },
      agent: { expose: binding.agent?.expose ?? false },
      deprecation: {
        deprecated,
        replacement: binding.deprecation?.replacement ?? null,
        since: binding.deprecation?.since ?? null,
        message: this.text(binding.deprecation?.message, `${bindingPointer}/deprecation/message`, "manifest"),
      },
      executionPolicyRef: binding.executionPolicy ?? null,
    };
  }

  securitySchemes(): Record<string, CatalogSecurityScheme> {
    const declared = this.declaredSchemes;
    const output: Record<string, CatalogSecurityScheme> = {};
    for (const name of Object.keys(declared).sort(compareCodeUnits)) {
      const schemePointer = `/components/securitySchemes/${pointerSegment(name)}`;
      this.identifier(name, schemePointer, "Security scheme name");
      const resolved = this.deref(declared[name], schemePointer);
      if (!resolved) continue;
      const { value, pointer } = resolved;
      if (typeof value.type !== "string" || !SECURITY_SCHEME_TYPES.includes(value.type)) {
        this.report("INVALID_SPEC", `${pointer}/type`, `Security scheme ${quote(name)} needs a type of ${SECURITY_SCHEME_TYPES.join(", ")}.`);
        continue;
      }
      const scheme: CatalogSecurityScheme = { type: value.type, description: this.text(own(value, "description"), `${pointer}/description`) };
      for (const key of ["scheme", "in", "name"] as const) {
        const member = this.member(value, key, pointer, STRING);
        if (member !== undefined) scheme[key] = this.identifier(member, `${pointer}/${key}`, `Security scheme ${key}`);
      }
      // Each type's required members, as OpenAPI defines them. A present value of the wrong type is already reported.
      const requireMember = (key: string, valid: boolean, need: string) => {
        const member = own(value, key);
        if (!valid && (member === undefined || typeof member === "string" || (key === "flows" && isRecord(member)))) {
          this.report("INVALID_SPEC", `${pointer}/${key}`, `Security scheme ${quote(name)} of type ${value.type} needs ${need}.`);
        }
      };
      if (value.type === "apiKey") {
        requireMember("in", API_KEY_LOCATIONS.includes(scheme.in ?? ""), `"in" of ${API_KEY_LOCATIONS.join(", ")}`);
        requireMember("name", Boolean(scheme.name?.trim()), "a non-empty name");
      }
      if (value.type === "http") requireMember("scheme", Boolean(scheme.scheme?.trim()), "a non-empty scheme");
      const bearerFormat = this.text(own(value, "bearerFormat"), `${pointer}/bearerFormat`);
      if (bearerFormat !== null) scheme.bearerFormat = bearerFormat;
      const openIdConnectUrl = this.url(own(value, "openIdConnectUrl"), `${pointer}/openIdConnectUrl`);
      if (openIdConnectUrl !== null) scheme.openIdConnectUrl = openIdConnectUrl;
      if (value.type === "openIdConnect") requireMember("openIdConnectUrl", Boolean(openIdConnectUrl?.trim()), "a non-empty openIdConnectUrl");
      // OpenAPI defines flows for oauth2 only; other types never carry them.
      const declaredFlows = value.type === "oauth2" ? this.member(value, "flows", pointer, OBJECT) : undefined;
      if (value.type === "oauth2") {
        const flowCount = Object.keys(declaredFlows ?? {}).filter((key) => !key.startsWith("x-")).length;
        requireMember("flows", flowCount > 0, `flows with at least one of ${Object.keys(OAUTH_FLOW_URLS).join(", ")}`);
      }
      if (declaredFlows !== undefined) {
        const flows: NonNullable<CatalogSecurityScheme["flows"]> = {};
        // Specification extensions (`x-*`) are not flows.
        for (const flowName of Object.keys(declaredFlows).filter((key) => !key.startsWith("x-")).sort(compareCodeUnits)) {
          const flow = declaredFlows[flowName];
          const flowPointer = `${pointer}/flows/${pointerSegment(flowName)}`;
          this.identifier(flowName, flowPointer, "OAuth flow name");
          if (!isRecord(flow)) {
            this.report("INVALID_SPEC", flowPointer, `OAuth flow ${quote(flowName)} of security scheme ${quote(name)} must be an object.`);
            continue;
          }
          const requiredUrls = own(OAUTH_FLOW_URLS, flowName) as (typeof OAUTH_FLOW_URLS)[string] | undefined;
          if (requiredUrls === undefined) {
            this.report("INVALID_SPEC", flowPointer, `OAuth flow ${quote(flowName)} of security scheme ${quote(name)} is not one of ${Object.keys(OAUTH_FLOW_URLS).join(", ")}.`);
          }
          const declaredScopes = this.member(flow, "scopes", flowPointer, OBJECT);
          if (own(flow, "scopes") === undefined) {
            this.report("INVALID_SPEC", `${flowPointer}/scopes`, `OAuth flow ${quote(flowName)} of security scheme ${quote(name)} needs scopes (an object, possibly empty).`);
          }
          const scopes = Object.keys(declaredScopes ?? {});
          const output: NonNullable<CatalogSecurityScheme["flows"]>[string] = {
            scopes: sortStrings(scopes.map((scope) => this.identifier(scope, `${flowPointer}/scopes/${pointerSegment(scope)}`, "Scope name"))),
          };
          for (const key of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
            const declaredUrl = own(flow, key);
            const url = this.url(declaredUrl, `${flowPointer}/${key}`);
            if (url !== null) output[key] = url;
            if (!url?.trim() && requiredUrls?.includes(key as "authorizationUrl" | "tokenUrl") && (declaredUrl === undefined || typeof declaredUrl === "string")) {
              this.report("INVALID_SPEC", `${flowPointer}/${key}`, `OAuth flow ${quote(flowName)} of security scheme ${quote(name)} needs a non-empty ${key}.`);
            }
          }
          setOwn(flows, flowName, output);
        }
        scheme.flows = flows;
      }
      setOwn(output, name, scheme);
    }
    return output;
  }

  /**
   * Emits every component schema reached from an operation. A component
   * reached from a credential field, or describing an instance one could fill
   * (see {@link Taint}), is emitted without literals. Its final
   * taint is settled first, in a dry run with reports discarded: each name is
   * queued when first referenced and again when tainted, so a long chain is
   * walked once. Then each component is emitted once, in name order, so its
   * output and diagnostics never depend on the order references were found.
   */
  componentSchemas(): Record<string, JsonValue> {
    const components = this.schemaComponents;
    const settled = new Map<string, Taint>();
    this.muted += 1;
    for (let next = 0; next < this.pendingComponents.length; next += 1) {
      const name = this.pendingComponents[next];
      const taint = this.componentRefs.get(name)!;
      if ((settled.get(name) ?? -1) >= taint) continue;
      settled.set(name, taint);
      this.schema(own(components, name), `/components/schemas/${pointerSegment(name)}`, taint === 2, taint >= 1);
    }
    this.muted -= 1;
    const output: Record<string, JsonValue> = {};
    for (const name of Array.from(settled.keys()).sort(compareCodeUnits)) {
      const pointer = `/components/schemas/${pointerSegment(name)}`;
      this.identifier(name, pointer, "Component schema name");
      const taint = this.componentRefs.get(name)!;
      const schema = this.schema(own(components, name), pointer, taint === 2, taint >= 1);
      if (schema !== null) setOwn(output, name, schema);
    }
    return output;
  }

  servers(list: unknown[], pointer: string): CatalogServer[] {
    return list.flatMap((server, index) => {
      const serverPointer = `${pointer}/${index}`;
      if (!isRecord(server) || typeof server.url !== "string" || server.url === "") {
        this.report("INVALID_SPEC", serverPointer, `Server ${serverPointer} needs a non-empty url.`);
        return [];
      }
      const template = server.url;
      const url = this.url(template, `${serverPointer}/url`, { dropQuery: true }) as string;
      if (url === "") {
        this.report("INVALID_SPEC", `${serverPointer}/url`, `Server ${serverPointer} has no URL left once its query and fragment are removed; give it a base URL.`);
        return [];
      }
      const declared = this.member(server, "variables", serverPointer, OBJECT) ?? {};
      const names = Object.keys(declared).sort(compareCodeUnits);
      const defaults: Record<string, string> = {};
      const enums = new Map<string, string[] | null>();
      for (const name of names) {
        const variable = declared[name];
        const variablePointer = `${serverPointer}/variables/${pointerSegment(name)}`;
        this.identifier(name, variablePointer, "Server variable name");
        if (!isRecord(variable) || typeof variable.default !== "string") {
          this.report("INVALID_SPEC", variablePointer, `Server variable ${quote(name)} at ${serverPointer} needs a string default.`);
          continue;
        }
        setOwn(defaults, name, variable.default);
        enums.set(name, this.member(variable, "enum", variablePointer, STRING_LIST) ?? null);
      }
      const valid = names.filter((name) => Object.hasOwn(defaults, name));
      // Judged against the original template: a variable with an occurrence in the removed user info, query or
      // fragment (or none left in the emitted URL) only fills a removed part, so its values may be credentials.
      const occurrences = placeholderCounts(template);
      const kept = placeholderCounts(url);
      const removed = (name: string) => (kept.get(name) ?? 0) === 0 || kept.get(name)! < (occurrences.get(name) ?? 0);
      const hidden = new Set(valid.filter((name) => isCredentialKey(name) || removed(name)));
      // Values are judged in the URL expanded with all defaults, then with each enum value in turn (other variables at
      // their judged defaults), so values that only together form user info, a query or a fragment are caught.
      // Every judgement is charged to the build's server budget before its expansion; one beyond it hides every
      // visible variable, as hideJointServerValues does.
      const expandedLength = (values: Record<string, string>) =>
        valid.reduce((total, name) => total + (occurrences.get(name) ?? 0) * values[name].length, template.length);
      const charge = (length: number) => () => chargeBudget(this.serverScanBudget, length);
      let exhausted = false;
      const exhaust = () => {
        if (exhausted) return;
        exhausted = true;
        valid.forEach((name) => hidden.add(name));
      };
      const cuts = new Set<string>();
      const judged: Record<string, string> = { ...defaults };
      const defaultsLength = expandedLength(defaults);
      for (const name of valid.filter((name) => !hidden.has(name))) {
        const verdict = judgeServerValue(template, defaults, name, defaults[name], charge(defaultsLength));
        if ("overflow" in verdict) {
          exhaust();
        } else if ("hide" in verdict) {
          verdict.hide.forEach((other) => hidden.add(other));
        } else if (verdict.cut) {
          setOwn(judged, name, verdict.value);
          cuts.add(`${name}/default`);
        }
      }
      const enumValues = new Map<string, string[]>();
      const judgedLength = expandedLength(judged);
      for (const name of valid.filter((name) => !hidden.has(name) && enums.get(name))) {
        const count = occurrences.get(name) ?? 0;
        enumValues.set(name, enums.get(name)!.map((entry, index) => {
          const verdict = judgeServerValue(template, judged, name, entry, charge(judgedLength + count * (entry.length - judged[name].length)));
          if ("overflow" in verdict) {
            exhaust();
            return entry;
          }
          if ("hide" in verdict) {
            verdict.hide.forEach((other) => hidden.add(other));
            return entry;
          }
          if (verdict.cut) cuts.add(`${name}/enum/${index}`);
          return verdict.value;
        }));
      }
      // Every combination of declared values, judged together: one variable's scheme and another's user info meet only there.
      const joint = hideJointServerValues(
        template,
        valid,
        occurrences,
        hidden,
        (name) => (hidden.has(name) ? [defaults[name], ...(enums.get(name) ?? [])] : [judged[name], ...(enumValues.get(name) ?? [])]),
        this.serverScanBudget
      );
      const overflow = exhausted || joint;
      const variables: CatalogServer["variables"] = {};
      for (const name of valid) {
        const variable = declared[name] as Record<string, unknown>;
        const variablePointer = `${serverPointer}/variables/${pointerSegment(name)}`;
        const values = enums.get(name) ?? null;
        const hide = hidden.has(name);
        if (isCredentialKey(name)) {
          this.report("CREDENTIAL_REDACTED", variablePointer, `Replaced the values of credential-named server variable ${quote(name)}; credentials never belong in server URLs.`, { severity: "warning" });
        } else if (hide) {
          const why = overflow
            ? `server variable ${quote(name)} of ${serverPointer}/url, whose values have more combinations than the catalog judges for user info, a query or a fragment (more than ${SERVER_COMBINATION_LIMIT}, or more than ${SERVER_SCAN_BUDGET} characters of expanded URLs in one document)`
            : `server variable ${quote(name)} fills user info, a query or a fragment of ${serverPointer}/url, which the catalog removes`;
          this.report("CREDENTIAL_REDACTED", `${variablePointer}/default`, `Replaced the default of ${why}.`, { severity: "warning" });
          values?.forEach((_, valueIndex) => this.report("CREDENTIAL_REDACTED", `${variablePointer}/enum/${valueIndex}`, `Removed enum value ${valueIndex} of ${why}.`, { severity: "warning" }));
        }
        /** A value that put user info into the URL lost it; the rest is copied as text. */
        const value = (raw: string, field: string): string => {
          const valuePointer = `${variablePointer}/${field}`;
          if (cuts.has(`${name}/${field}`)) {
            this.report("CREDENTIAL_REDACTED", valuePointer, `Removed the user info that server variable ${quote(name)} puts into the URL at ${serverPointer}/url; URLs never carry user info.`, { severity: "warning" });
          }
          return this.text(raw, valuePointer) as string;
        };
        setOwn(variables, name, {
          default: hide ? REDACTED : value(judged[name], "default"),
          enum: values && !hide ? enumValues.get(name)!.map((entry, valueIndex) => value(entry, `enum/${valueIndex}`)) : null,
          description: this.text(own(variable, "description"), `${variablePointer}/description`),
        });
      }
      return [{
        url,
        description: this.text(own(server, "description"), `${serverPointer}/description`),
        variables,
      }];
    });
  }

  private operationId(operation: Record<string, unknown>, pointer: string): string | null {
    const operationId = this.member(operation, "operationId", pointer, STRING);
    return operationId === undefined ? null : this.identifier(operationId, `${pointer}/operationId`, "OpenAPI operationId");
  }

  specOperations(): SpecOperation[] {
    const paths = isRecord(this.doc.paths) ? this.doc.paths : {};
    const operations: SpecOperation[] = [];
    for (const path of Object.keys(paths).sort(compareCodeUnits)) {
      if (path.startsWith("x-")) continue;
      if (!path.startsWith("/")) {
        this.report("INVALID_SPEC", `/paths/${pointerSegment(path)}`, `Path ${quote(path)} must start with "/".`);
        continue;
      }
      this.identifier(path, `/paths/${pointerSegment(path)}`, "Path template");
      const resolved = this.deref(paths[path], `/paths/${pointerSegment(path)}`, true);
      if (!resolved) continue;
      for (const method of METHODS) {
        const operation = own(resolved.value, method);
        if (operation === undefined) continue;
        if (!isRecord(operation)) {
          this.report("INVALID_SPEC", `/paths/${pointerSegment(path)}/${method}`, `Operation ${method.toUpperCase()} ${redactWhole(path)} must be an object, not ${describeValue(operation)}.`);
          continue;
        }
        operations.push({
          method,
          path,
          pointer: `/paths/${pointerSegment(path)}/${method}`,
          pathItem: resolved.value,
          pathItemPointer: resolved.pointer,
          operation,
          operationId: this.operationId(operation, `/paths/${pointerSegment(path)}/${method}`),
        });
      }
    }
    return operations;
  }

  build(): Omit<OperationCatalog, "source"> & { provenance: OperationCatalog["source"]["provenance"] } {
    this.checkRefs();
    const specOperations = this.specOperations();

    const byOperationId = new Map<string, SpecOperation>();
    const byRoute = new Map<string, SpecOperation>();
    for (const entry of specOperations) {
      byRoute.set(`${entry.method} ${entry.path}`, entry);
      if (entry.operationId === null) continue;
      const existing = byOperationId.get(entry.operationId);
      if (existing) {
        this.report("DUPLICATE_OPERATION_ID", `${entry.pointer}/operationId`, `OpenAPI operationId ${quote(entry.operationId)} is used by both ${existing.method.toUpperCase()} ${redactWhole(existing.path)} and ${entry.method.toUpperCase()} ${redactWhole(entry.path)}.`);
      } else {
        byOperationId.set(entry.operationId, entry);
      }
    }

    const bound = new Map<SpecOperation, OperationBinding>();
    const stableIds = new Set<string>();
    this.manifest.operations.forEach((binding, index) => {
      const pointer = `/operations/${index}`;
      if (stableIds.has(binding.id)) {
        this.report("DUPLICATE_OPERATION_ID", `${pointer}/id`, `Stable operation ID ${quote(binding.id)} is declared more than once in the manifest.`, { source: "manifest", operation: binding.id });
        return;
      }
      stableIds.add(binding.id);
      const entry = binding.operationId !== undefined
        ? byOperationId.get(binding.operationId)
        : byRoute.get(`${binding.method?.toLowerCase()} ${binding.path}`);
      if (!entry) {
        const target = binding.operationId !== undefined ? `operationId ${quote(binding.operationId)}` : `${binding.method?.toUpperCase()} ${redactWhole(binding.path ?? "")}`;
        this.report("UNMATCHED_OPERATION_BINDING", pointer, `Stable operation ${quote(binding.id)} binds ${target}, which is not in the spec; update or remove the binding.`, { source: "manifest", operation: binding.id });
        return;
      }
      const previous = bound.get(entry);
      if (previous) {
        this.report("DUPLICATE_OPERATION_ID", pointer, `${entry.method.toUpperCase()} ${redactWhole(entry.path)} is bound by both ${quote(previous.id)} and ${quote(binding.id)}; each operation needs exactly one stable ID.`, { source: "manifest", operation: binding.id });
        return;
      }
      bound.set(entry, binding);
    });

    const operations: CatalogOperation[] = [];
    for (const entry of specOperations) {
      const binding = bound.get(entry);
      if (!binding) {
        this.report("MISSING_OPERATION_ID", entry.pointer, `${entry.method.toUpperCase()} ${redactWhole(entry.path)}${entry.operationId ? ` (operationId ${quote(entry.operationId)})` : ""} has no stable operation ID; add a manifest binding.`);
        continue;
      }
      operations.push(this.operation(entry, binding));
    }
    operations.sort((a, b) => compareCodeUnits(a.id, b.id));

    const names = new Map<string, CatalogOperation>();
    for (const operation of operations) {
      const pointer = `/operations/${this.manifest.operations.findIndex((binding) => binding.id === operation.id)}`;
      const existing = names.get(nameKey(operation.name));
      if (existing) {
        this.report("NAME_COLLISION", pointer, `Operations ${quote(existing.id)} and ${quote(operation.id)} resolve to colliding names ${quote(existing.name)} and ${quote(operation.name)}; set a distinct manifest name.`, { source: "manifest", operation: operation.id });
      } else {
        names.set(nameKey(operation.name), operation);
      }
      const replacement = operation.deprecation.replacement;
      if (replacement !== null && (replacement === operation.id || !operations.some((op) => op.id === replacement))) {
        this.report("UNKNOWN_REPLACEMENT", `${pointer}/deprecation/replacement`, `Operation ${quote(operation.id)} names replacement ${quote(replacement)}, which is not another operation in this catalog.`, { source: "manifest", operation: operation.id });
      }
      if (operation.agent.expose && operation.executionPolicyRef === null) {
        this.report("AGENT_POLICY_REQUIRED", `${pointer}/agent/expose`, `Operation ${quote(operation.id)} is exposed to agents without an executionPolicy reference; HTTP method and schema never imply authorization or idempotency.`, { source: "manifest", operation: operation.id });
      }
    }

    const info = this.doc.info as Record<string, unknown>;
    const provenance = this.manifest.provenance ?? {};
    return {
      catalogVersion: CATALOG_VERSION,
      api: { id: this.manifest.api.id, version: this.manifest.api.version, title: this.text(own(info, "title"), "/info/title") ?? "" },
      provenance: {
        source: this.url(provenance.source, "/provenance/source", { source: "manifest" }),
        revision: this.text(provenance.revision, "/provenance/revision", "manifest"),
        exporter: this.text(provenance.exporter, "/provenance/exporter", "manifest"),
      },
      serialization: { mediaTypes: sortStrings(this.mediaTypes) },
      servers: this.servers(this.member(this.doc, "servers", "", LIST) ?? [], "/servers"),
      securitySchemes: this.securitySchemes(),
      operations,
      schemas: this.componentSchemas(),
    };
  }
}

/**
 * Reads OpenAPI text as @apifn/core's parseOpenAPI does (JSON, else YAML, with
 * its error messages), so that the document reaches {@link parseDocument} as data.
 */
function readOpenApiText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Invalid OpenAPI input: empty string");
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    try {
      raw = parseYaml(trimmed);
    } catch (error) {
      throw new Error(`Invalid OpenAPI input: failed to parse JSON or YAML (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!isRecord(raw)) throw new Error("Invalid OpenAPI document: expected object");
  return raw;
}

/**
 * parseOpenAPI on the document, with OpenAPI 3.0 upconverted here first. The
 * @apifn/core upconvert rewrites every `nullable: true` member, literals and
 * map keys included, and the published 0.0.3 loses own `"__proto__"` keys;
 * core returns a 3.1.0 document as given, so the catalog does not depend on
 * which core is installed. `doc` is the build's own snapshot (a tree: no
 * object is reachable by two paths), so it is converted in place.
 */
function parseDocument(doc: Record<string, unknown>): unknown {
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.0.")) return parseOpenAPI(doc);
  // Every Schema Object is found before any is changed, so references resolve in the source document.
  for (const schema of schemaObjects(doc)) {
    if (own(schema, "nullable") !== true) continue;
    delete schema.nullable;
    const type = own(schema, "type");
    if (typeof type === "string") schema.type = [type, "null"];
    else if (Array.isArray(type)) schema.type = Array.from(new Set([...type, "null"]));
  }
  doc.openapi = "3.1.0";
  return parseOpenAPI(doc);
}

/** The OpenAPI objects that can hold Schema Objects, as the catalog reads them. */
type OpenApiObjectKind = "pathItem" | "callback" | "parameter" | "requestBody" | "response" | "schema";

/**
 * The Schema Objects of a document, found by OpenAPI object context as the
 * catalog resolves it: from the paths and components, and through every
 * Reference Object at a typed position, wherever its target is (`#/x-param`,
 * another operation's member, a chain of up to 32 objects as in deref).
 * A target is read with the type of the position referencing it; the fields
 * beside a Path Item `$ref` are Path Item fields, read as well. Literals,
 * map keys and `x-*` members of the Paths, Responses and Callback maps are
 * never Schema Object positions unless a reference reaches them. Schema
 * references are not followed: the catalog resolves them only to component
 * schemas, which are walked from the components.
 */
function schemaObjects(doc: Record<string, unknown>): Set<Record<string, unknown>> {
  const schemas = new Set<Record<string, unknown>>();
  // The fewest reference hops each object was reached with, per kind: a shorter chain may follow further.
  const seen = new Map<Record<string, unknown>, Map<OpenApiObjectKind, number>>();
  const references: Array<[target: unknown, kind: OpenApiObjectKind, hops: number]> = [];
  const map = (value: unknown, kind: OpenApiObjectKind, skipExtensions = false) => {
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) if (!(skipExtensions && key.startsWith("x-"))) visit(entry, kind);
  };
  const list = (value: unknown, kind: OpenApiObjectKind) => {
    if (Array.isArray(value)) for (const entry of value) visit(entry, kind);
  };
  const content = (value: unknown) => {
    if (!isRecord(value)) return;
    for (const media of Object.values(value)) {
      if (!isRecord(media)) continue;
      visit(own(media, "schema"), "schema");
      const encodings = own(media, "encoding");
      if (isRecord(encodings)) for (const encoding of Object.values(encodings)) if (isRecord(encoding)) map(own(encoding, "headers"), "parameter");
    }
  };
  const visit = (value: unknown, kind: OpenApiObjectKind, hops = 0): void => {
    if (!isRecord(value)) return;
    const reference = kind !== "schema" && Object.hasOwn(value, "$ref");
    const kinds = seen.get(value) ?? new Map<OpenApiObjectKind, number>();
    seen.set(value, kinds);
    const reached = reference ? hops : 0;
    if ((kinds.get(kind) ?? Infinity) <= reached) return;
    kinds.set(kind, reached);
    if (reference) {
      // A chain reads at most 32 objects, as in deref.
      const ref = own(value, "$ref");
      if (typeof ref === "string" && hops + 1 < 32) references.push([resolvePointer(doc as Doc, ref), kind, hops + 1]);
      // A Reference Object's siblings are ignored. A Path Item `$ref` is a Path Item field: the fields beside it are read too.
      if (kind !== "pathItem") return;
    }
    switch (kind) {
      case "schema":
        schemas.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (SCHEMA_MAP_KEYWORDS.has(key)) map(child, "schema");
          else if (SCHEMA_LIST_KEYWORDS.has(key) || (key === "items" && Array.isArray(child))) list(child, "schema");
          else if (SCHEMA_KEYWORDS.has(key)) visit(child, "schema");
        }
        return;
      case "pathItem":
        list(own(value, "parameters"), "parameter");
        for (const method of METHODS) {
          const operation = own(value, method);
          if (!isRecord(operation)) continue;
          list(own(operation, "parameters"), "parameter");
          visit(own(operation, "requestBody"), "requestBody");
          map(own(operation, "responses"), "response", true);
          map(own(operation, "callbacks"), "callback");
        }
        return;
      case "callback":
        map(value, "pathItem", true);
        return;
      case "parameter":
        visit(own(value, "schema"), "schema");
        content(own(value, "content"));
        return;
      case "requestBody":
        content(own(value, "content"));
        return;
      case "response":
        map(own(value, "headers"), "parameter");
        content(own(value, "content"));
        return;
    }
  };
  map(own(doc, "paths"), "pathItem", true);
  const components = own(doc, "components");
  if (isRecord(components)) {
    const kinds: Record<string, OpenApiObjectKind> = {
      schemas: "schema",
      parameters: "parameter",
      headers: "parameter",
      requestBodies: "requestBody",
      responses: "response",
      callbacks: "callback",
    };
    for (const [section, kind] of Object.entries(kinds)) map(own(components, section), kind);
  }
  // A queue, not recursion, so a long chain of references cannot exhaust the stack.
  for (let index = 0; index < references.length; index += 1) visit(...references[index]);
  return schemas;
}

/**
 * Describes why the document could not be read. Parser failures report only
 * line and column: parser messages quote source text, which may hold secrets.
 */
function parseFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (/failed to parse JSON or YAML/.test(reason)) {
    const location = /\bline (\d+), column (\d+)/.exec(reason);
    return `Cannot parse the OpenAPI document as JSON or YAML${location ? ` (line ${location[1]}, column ${location[2]})` : ""}.`;
  }
  if (/^(?:Invalid OpenAPI|Unsupported OpenAPI version|document requires)/.test(reason)) {
    return `Cannot read the OpenAPI document: ${redactWhole(reason.split("\n")[0]).slice(0, 200)}`;
  }
  return "Cannot read the OpenAPI document: it is malformed or not plain JSON data.";
}

const SEVERITY_ORDER = { error: 0, warning: 1 } as const;

/**
 * Deduplicates and orders diagnostics. Pointers and messages are built from
 * author keys and values, so both are redacted: no diagnostic carries a credential.
 */
function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const redacted = diagnostics.map((diagnostic) => ({ ...diagnostic, ...sanitizeReport(diagnostic.pointer, diagnostic.message) }));
  const unique = new Map(redacted.map((diagnostic) => [canonicalJson(diagnostic), diagnostic]));
  return Array.from(unique.values()).sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareCodeUnits(a.source, b.source) ||
      compareCodeUnits(a.pointer, b.pointer) ||
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.message, b.message)
  );
}

/**
 * Builds the normalized operation catalog for an OpenAPI document (JSON/YAML
 * string or object, 3.0 or 3.1) and its companion manifest. Identical inputs
 * produce byte-identical `canonicalJson(catalog)` and digest; any error
 * diagnostic yields a null catalog.
 */
export function buildOperationCatalog(spec: string | Record<string, unknown>, manifest: unknown): BuildCatalogResult {
  const diagnostics: Diagnostic[] = [];
  // Inputs are read once into bounded plain data: cycles, getters, class
  // instances, YAML alias expansion and excessive nesting are reported, never thrown.
  /** The snapshot, or null after reporting why the input is not plain data (or is not an object at all). */
  const plain = (value: unknown, code: "INVALID_SPEC" | "INVALID_MANIFEST", source: Diagnostic["source"]): unknown => {
    if (!isRecord(value)) {
      const what = source === "spec" ? "The OpenAPI document must be a JSON or YAML string or an object" : "The manifest must be an object";
      diagnostics.push({ code, severity: "error", message: `${what}, found ${describeValue(value)}.`, pointer: "", source });
      return null;
    }
    let snapshot: ReturnType<typeof snapshotPlainData>;
    try {
      snapshot = snapshotPlainData(value, { maxDepth: MAX_DOCUMENT_DEPTH });
    } catch {
      snapshot = { value: undefined, problems: [{ pointer: "", reason: "could not be read (a getter or proxy threw)" }] };
    }
    for (const { pointer, reason } of snapshot.problems) {
      diagnostics.push({ code, severity: "error", message: `The ${source === "spec" ? "OpenAPI document" : "manifest"} at ${pointer || "/"} ${reason}.`, pointer, source });
    }
    return snapshot.problems.length > 0 ? null : snapshot.value;
  };
  let doc: Doc | null = null;
  let specDigest = "";
  try {
    const input = plain(typeof spec === "string" ? readOpenApiText(spec) : spec, "INVALID_SPEC", "spec");
    if (input !== null) {
      doc = parseDocument(input as Record<string, unknown>) as Doc;
      if (!isRecord(doc.paths) || !isRecord(doc.info)) throw new Error("document requires info and paths objects");
      specDigest = canonicalDigest(doc);
    }
  } catch (error) {
    doc = null;
    diagnostics.push({ code: "INVALID_SPEC", severity: "error", message: parseFailure(error), pointer: "", source: "spec" });
  }

  const manifestData = plain(manifest, "INVALID_MANIFEST", "manifest");
  const validated = manifestData === null ? { manifest: null, diagnostics: [] } : validateManifest(manifestData);
  diagnostics.push(...validated.diagnostics);
  let manifestDigest = "";
  if (validated.manifest) {
    try {
      manifestDigest = canonicalDigest(validated.manifest);
    } catch {
      diagnostics.push({ code: "INVALID_MANIFEST", severity: "error", message: "The manifest must be plain JSON data (no class instances, Maps, non-finite numbers, sparse arrays or lone surrogates).", pointer: "", source: "manifest" });
    }
  }
  if (!doc || !validated.manifest || manifestDigest === "") {
    return { catalog: null, digest: null, diagnostics: sortDiagnostics(diagnostics) };
  }

  const builder = new CatalogBuilder(doc, validated.manifest);
  const { provenance, ...built } = builder.build();
  diagnostics.push(...builder.diagnostics);
  const sorted = sortDiagnostics(diagnostics);
  if (sorted.some((diagnostic) => diagnostic.severity === "error")) {
    return { catalog: null, digest: null, diagnostics: sorted };
  }

  const catalog = JSON.parse(
    canonicalJson({ ...built, source: { specDigest, manifestDigest, provenance } })
  ) as OperationCatalog;
  return { catalog, digest: canonicalDigest(catalog), diagnostics: sorted };
}
