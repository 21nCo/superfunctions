import { parseOpenAPI } from "@apifn/core";
import { canonicalDigest, canonicalJson, compareCodeUnits, MAX_JSON_DEPTH, snapshotPlainData } from "./canonical.js";
import {
  containsCredentialIdentifier,
  containsCredentialValue,
  credentialValueFields,
  isCredentialKey,
  pointerSegment,
  REDACTED,
  redactCredentialValues,
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
/** Schema keywords holding literal instance data; dropped for credential fields. */
const LITERAL_KEYWORDS = new Set(["default", "const", "enum"]);
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
 * credential-bearing key, or a name field naming a credential next to a value
 * field (`{name: "X-Api-Key", value: "..."}`), as the text rule reads it.
 */
function hasCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialKey);
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

function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

interface Expansion {
  text: string;
  /** Where each substituted value lands in `text`. */
  spans: Array<{ name: string; start: number; end: number }>;
}

/** Expands `{name}` server variables, recording where each value lands; undeclared ones stay as written. */
function expandServerUrl(url: string, values: Record<string, string>): Expansion {
  const spans: Expansion["spans"] = [];
  let text = "";
  let copied = 0;
  for (const match of url.matchAll(/\{([^{}]*)\}/g)) {
    text += url.slice(copied, match.index);
    copied = match.index + match[0].length;
    const name = match[1];
    if (!Object.hasOwn(values, name)) {
      text += match[0];
      continue;
    }
    spans.push({ name, start: text.length, end: text.length + values[name].length });
    text += values[name];
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
function judgeServerValue(template: string, values: Record<string, string>, name: string): { value: string; cut: boolean } | { hide: string[] } {
  const expansion = expandServerUrl(template, values);
  const overlaps = (span: { start: number; end: number }, part: { start: number; end: number }) => span.start < part.end && span.end > part.start;
  const own = expansion.spans.filter((span) => span.name === name);
  const hits = removedServerUrlSpans(expansion.text).filter((part) => own.some((span) => overlaps(span, part)));
  if (hits.length === 0) return { value: values[name], cut: false };
  const [part] = hits;
  const occurrence = own.find((span) => span.start <= part.start && span.end >= part.end);
  if (hits.length === 1 && part.userInfo && occurrence && expansion.spans.every((span) => span === occurrence || !overlaps(span, part))) {
    const raw = values[name];
    const value = raw.slice(0, part.start - occurrence.start) + raw.slice(part.end - occurrence.start);
    const retry = judgeServerValue(template, { ...values, [name]: value }, name);
    return "hide" in retry ? retry : { value: retry.value, cut: true };
  }
  return { hide: Array.from(new Set(expansion.spans.filter((span) => hits.some((hit) => overlaps(span, hit))).map((span) => span.name))) };
}

/** The most combinations of server variable values judged one by one; beyond it the judgement fails closed. */
const SERVER_COMBINATION_LIMIT = 4096;

/**
 * Hides every visible variable that some combination of declared values puts
 * into user info, a query or a fragment of the expanded `template`. A hidden
 * variable's values are never published, so it takes each raw value; a
 * visible one each value the catalog would publish. Hiding a variable widens
 * its values to the raw ones, so this repeats until nothing more is hidden.
 * When the combinations exceed {@link SERVER_COMBINATION_LIMIT} and any value
 * or the template holds `@`, `?` or `#` (without one nothing can be
 * removed), every visible variable is hidden and true is returned.
 */
function hideJointServerValues(template: string, names: string[], hidden: Set<string>, candidates: (name: string) => string[]): boolean {
  const used = names.filter((name) => template.includes(`{${name}}`));
  for (;;) {
    const visible = used.filter((name) => !hidden.has(name));
    if (visible.length === 0) return false;
    const lists = used.map((name) => Array.from(new Set(candidates(name))));
    if (!template.includes("@") && lists.every((list) => list.every((value) => !/[@?#]/.test(value)))) return false;
    const count = lists.reduce((product, list) => product * list.length, 1);
    if (count > SERVER_COMBINATION_LIMIT) {
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

/** Escapes a component name for a `$ref` emitted into the catalog (diagnostic pointers use pointerSegment). */
function refSegment(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** A reference for a message: a local one is a pointer, judged segment by segment so `~1~1` cannot hide URL user info. */
function showRef(ref: string): string {
  return ref.startsWith("#") ? `#${sanitizePointer(ref.slice(1))}` : redactCredentialValues(ref);
}

function decodePointerSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the raw segment; resolution fails below if it is not a key.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(doc: Doc, ref: string): unknown {
  if (!ref.startsWith("#/") && ref !== "#") return undefined;
  let current: unknown = doc;
  for (const raw of ref.slice(2).split("/").filter((segment, index) => segment !== "" || index > 0)) {
    const segment = decodePointerSegment(raw);
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
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
  if (!ref.startsWith(COMPONENT_SCHEMA_PREFIX)) return null;
  const segment = ref.slice(COMPONENT_SCHEMA_PREFIX.length);
  return segment === "" || segment.includes("/") ? null : decodePointerSegment(segment);
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

class CatalogBuilder {
  readonly diagnostics: Diagnostic[] = [];
  /** Component schemas reached from operations; true when reached from a credential field. */
  private readonly componentRefs = new Map<string, boolean>();
  /** Component names whose entry in componentRefs is new or newly tainted, for componentSchemas to emit. */
  private readonly pendingComponents: string[] = [];
  /** The schema graph {@link reachesCredentialField} has explored, the schemas known to reach a credential field, and reverse edges. */
  private readonly reach = {
    explored: new Set<Record<string, unknown>>(),
    reaching: new Set<Record<string, unknown>>(),
    parents: new Map<Record<string, unknown>, Array<Record<string, unknown>>>(),
  };
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

  /** Copies author text, redacting recognizable credentials. A present non-string is INVALID_SPEC. */
  text(value: unknown, pointer: string, source: Diagnostic["source"] = "spec"): string | null {
    if (value === undefined) return null;
    if (typeof value !== "string") {
      this.report("INVALID_SPEC", pointer, `Expected a string at ${pointer}, found ${describeValue(value)}.`, { source });
      return null;
    }
    const redacted = redactCredentialValues(value);
    if (redacted !== value) {
      this.report("CREDENTIAL_REDACTED", pointer, `Removed a credential-like value from ${pointer}; credentials never belong in API descriptions.`, { severity: "warning", source });
    }
    return redacted;
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
      return `External reference "${shown}" is not supported; bundle external documents into the spec before building the catalog.`;
    }
    const target = resolvePointer(this.doc, ref);
    if (target === undefined) return `Reference "${shown}" does not resolve to a value in the spec.`;
    if (isRecord(target) || (expect === "schema" && typeof target === "boolean")) return null;
    return `Reference "${shown}" resolves to ${describeValue(target)}, not ${expect === "schema" ? "a Schema Object or boolean" : "an object"}.`;
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

  private walkPathItem(value: unknown, pointer: string): void {
    if (!isRecord(value) || this.checkRef(value, pointer, "object")) return;
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
  deref(value: unknown, pointer: string): { value: Record<string, unknown>; pointer: string } | null {
    if (value === undefined) return null;
    if (!isRecord(value)) {
      this.report("INVALID_SPEC", pointer, `Expected an object at ${pointer}, found ${describeValue(value)}.`);
      return null;
    }
    let current: Record<string, unknown> = value;
    let currentPointer = pointer;
    for (let hops = 0; hops < 32; hops += 1) {
      if (!Object.hasOwn(current, "$ref")) return { value: current, pointer: currentPointer };
      const problem = this.refProblem(current.$ref, "object");
      if (problem) {
        this.report("UNRESOLVED_REF", `${currentPointer}/$ref`, problem);
        return null;
      }
      const ref = current.$ref as string;
      currentPointer = sanitizePointer(ref.slice(1));
      current = resolvePointer(this.doc, ref) as Record<string, unknown>;
    }
    this.report("UNRESOLVED_REF", pointer, `Reference chain at ${pointer} is cyclic or longer than 32 hops.`);
    return null;
  }

  /**
   * Copies a schema without examples or extensions. Inside a credential field
   * (a credential parameter or property, `format: password`, or any
   * subschema, applicator or component reached from one) literal values and
   * unrecognized members are dropped. Members holding credential-named keys
   * are dropped everywhere. Other literal data is copied verbatim.
   */
  schema(value: unknown, pointer: string, credential = false): JsonValue | null {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (!isRecord(value)) {
      this.report("INVALID_SPEC", pointer, `Expected a Schema Object or boolean at ${pointer}, found ${describeValue(value)}.`);
      return null;
    }
    const secret = credential || value.format === "password";
    const output: Record<string, JsonValue> = {};
    const drop = (key: string, childPointer: string, reason: string) =>
      this.report("CREDENTIAL_REDACTED", childPointer, `Dropped "${key}" at ${childPointer} because ${reason}.`, { severity: "warning" });
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${pointerSegment(key)}`;
      if (key === "example" || key === "examples" || key.startsWith("x-")) continue;
      if (isCredentialMember(key)) {
        drop(key, childPointer, "its name is or holds a credential");
      } else if (REFERENCE_KEYWORDS.has(key)) {
        const ref = this.schemaRef(child, childPointer, secret);
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
          const nested = this.schema(entry, `${childPointer}/${pointerSegment(name)}`, secret || (named && isCredentialKey(name)));
          if (nested !== null) setOwn(entries, name, nested);
        }
        setOwn(output, key, entries);
      } else if (SCHEMA_KEYWORDS.has(key)) {
        const nested = this.schema(child, childPointer, secret);
        if (nested !== null) setOwn(output, key, nested);
      } else if (SCHEMA_LIST_KEYWORDS.has(key)) {
        if (Array.isArray(child)) setOwn(output, key, child.map((entry, index) => this.schema(entry, `${childPointer}/${index}`, secret) ?? {}));
        else this.report("INVALID_SPEC", childPointer, `Expected an array of schemas at ${childPointer}, found ${describeValue(child)}.`);
      } else if (key === "discriminator") {
        if (isRecord(child)) setOwn(output, key, this.discriminator(child, childPointer, secret));
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
      } else if (secret && !CREDENTIAL_FIELD_KEYWORDS.has(key)) {
        drop(key, childPointer, "it is literal or unrecognized data inside a credential field");
      } else if (LITERAL_KEYWORDS.has(key) && this.reachesCredentialField(value)) {
        drop(key, childPointer, "the schema contains a credential field whose value the literal would carry");
      } else if (hasCredentialKey(child)) {
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
  private schemaRef(ref: unknown, pointer: string, secret: boolean): string | null {
    const problem = this.refProblem(ref, "schema");
    if (problem) {
      this.report("UNRESOLVED_REF", pointer, problem);
      return null;
    }
    const name = componentName(ref as string);
    if (name === null) {
      this.report("UNRESOLVED_REF", pointer, `Schema reference "${showRef(ref as string)}" must target ${COMPONENT_SCHEMA_PREFIX}<name> so generated clients can share the type.`);
      return null;
    }
    this.referComponent(name, secret);
    return `${COMPONENT_SCHEMA_PREFIX}${refSegment(name)}`;
  }

  /** Records a reference to component schema `name`, queueing it for componentSchemas when it is new or newly reached from a credential field. */
  private referComponent(name: string, secret: boolean): void {
    const before = this.componentRefs.get(name);
    const after = before === true || secret;
    if (before === after) return;
    this.componentRefs.set(name, after);
    this.pendingComponents.push(name);
  }

  /**
   * Copies a Discriminator Object. Every mapping target must be a component
   * schema (by name or `#/components/schemas/<name>`); targets are emitted as
   * references and the schemas they name join the catalog.
   */
  private discriminator(value: Record<string, unknown>, pointer: string, secret: boolean): JsonValue {
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
        const shown = typeof target === "string" ? showRef(target) : String(target);
        this.report("UNRESOLVED_REF", targetPointer, `Discriminator mapping "${redactCredentialValues(key)}" targets "${shown}", which is not a schema in ${COMPONENT_SCHEMA_PREFIX}<name>.`);
        continue;
      }
      this.referComponent(name, secret);
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
        this.report("INVALID_SPEC", encodingPointer, `Encoding of property "${name}" in operation "${operation}" must be an Encoding Object.`, { operation });
        continue;
      }
      const style = this.member(encoding, "style", encodingPointer, STRING, operation) ?? "form";
      if (!PARAMETER_STYLES.query.includes(style)) {
        this.report("UNSUPPORTED_SERIALIZATION", `${encodingPointer}/style`, `Property "${name}" of ${mediaType} in operation "${operation}" uses style "${style}"; supported styles are ${PARAMETER_STYLES.query.join(", ")}.`, { operation });
        continue;
      }
      if (encoding.headers !== undefined) {
        this.report("UNSUPPORTED_SERIALIZATION", `${encodingPointer}/headers`, `Part headers of property "${name}" in operation "${operation}" are not described in the catalog; generated clients will not send them.`, { severity: "warning", operation });
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
      this.report("INVALID_SPEC", pointer, `${what} of operation "${operation}" needs an object of media types at ${pointer}, found ${describeValue(content)}.`, { operation });
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
        this.report("INVALID_SPEC", mediaPointer, `${what} of operation "${operation}" describes ${rawType} with ${describeValue(media)} instead of a Media Type Object.`, { operation });
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
          `${what} of operation "${operation}" describes "${existing.rawType}" and "${rawType}" differently, but both are ${mediaType} to clients; keep one description per media type.`,
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
        : `the catalog cannot describe ${unsupported.join(", ")}, so the spec must also offer one of ${allowed}`;
      this.report(
        "UNSUPPORTED_SERIALIZATION",
        pointer,
        byType.size === 0
          ? `${what} of operation "${operation}" only offers ${unsupported.join(", ")}${parameterized}; ${advice}.`
          : `${what} of operation "${operation}" drops unsupported media types ${unsupported.join(", ")}${parameterized}; clients use ${allowed}.`,
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
        this.report("INVALID_SPEC", pointer, `Parameters at ${pointer} of operation "${id}" must be an array.`, { operation: id });
        continue;
      }
      // Header names are case-insensitive: X-A and x-a are one parameter, and the operation level wins.
      const level = new Set<string>();
      list.forEach((raw, index) => {
        const resolved = this.deref(raw, `${pointer}/${index}`);
        if (!resolved) return; // deref reported why.
        const { name, in: location } = resolved.value;
        if (typeof name !== "string" || name === "" || !PARAMETER_LOCATIONS.includes(location as CatalogParameter["in"])) {
          this.report("INVALID_SPEC", resolved.pointer, `Parameter at ${resolved.pointer} of operation "${id}" needs a name and an "in" of ${PARAMETER_LOCATIONS.join(", ")}.`, { operation: id });
          return;
        }
        this.identifier(name, `${resolved.pointer}/name`, "Parameter name", id);
        const key = parameterKey(location as string, name);
        if (level.has(key)) {
          this.report("INVALID_SPEC", `${pointer}/${index}`, `Parameter "${name}" in ${location} is declared twice at ${pointer} of operation "${id}"${location === "header" ? " (header names are case-insensitive)" : ""}.`, { operation: id });
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
        this.report("INVALID_SPEC", pointer, `Path parameter "${name}" of operation "${id}" is declared but does not appear in the path template ${entry.path}.`, { operation: id });
        continue;
      }
      if (location === "header" && IGNORED_HEADERS.has(name.toLowerCase())) continue;
      const style = this.member(value, "style", pointer, STRING, id) ?? (location === "query" || location === "cookie" ? "form" : "simple");
      if (value.content !== undefined || !PARAMETER_STYLES[location].includes(style)) {
        this.report(
          "UNSUPPORTED_SERIALIZATION",
          pointer,
          value.content !== undefined
            ? `Parameter "${name}" of operation "${id}" uses content-based serialization; describe it with a schema instead.`
            : `Parameter "${name}" of operation "${id}" uses style "${style}"; supported ${location} styles are ${PARAMETER_STYLES[location].join(", ")}.`,
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
        this.report("INVALID_SPEC", entry.pointer, `Path parameter "${name}" of operation "${id}" appears in the path template but is not declared.`, { operation: id });
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
          this.report("INVALID_SPEC", `${entry.pointer}/responses/${pointerSegment(status)}`, `Response key "${status}" of operation "${id}" is not an HTTP status, a 1XX-5XX range or "default".`, { operation: id });
          return [];
        }
        const resolved = this.deref(responses[status], `${entry.pointer}/responses/${pointerSegment(status)}`);
        if (!resolved) return [];
        const kind: CatalogResponse["kind"] = status === "default" ? "default" : /^[45]/.test(status) ? "error" : "success";
        const headers = this.member(resolved.value, "headers", resolved.pointer, OBJECT, id);
        // Header names are not extensions (`x-ratelimit-remaining` is a header); OpenAPI ignores Content-Type here.
        if (headers && Object.keys(headers).some((name) => name.toLowerCase() !== "content-type")) {
          this.report("UNSUPPORTED_SERIALIZATION", `${resolved.pointer}/headers`, `Response ${status} headers of operation "${id}" are not described in the catalog; generated clients will not expose them.`, { severity: "warning", operation: id });
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
      invalid(pointer, `Security of operation "${id}" at ${pointer} must be an array of security requirement objects.`);
      return [[]];
    }
    const alternatives = new Map<string, SecurityRequirementTerm[]>();
    (declared ?? []).forEach((requirement: unknown, index: number) => {
      const requirementPointer = `${pointer}/${index}`;
      if (!isRecord(requirement)) {
        invalid(requirementPointer, `Security requirement ${requirementPointer} of operation "${id}" must be an object of scheme names to scope arrays; use {} for anonymous access.`);
        return;
      }
      const terms: SecurityRequirementTerm[] = [];
      for (const scheme of Object.keys(requirement).sort(compareCodeUnits)) {
        const schemePointer = `${requirementPointer}/${pointerSegment(scheme)}`;
        this.identifier(scheme, schemePointer, "Security scheme name", id);
        if (!Object.hasOwn(schemes, scheme)) {
          this.report("UNKNOWN_SECURITY_SCHEME", schemePointer, `Operation "${id}" requires security scheme "${scheme}", which is not declared in components.securitySchemes.`, { operation: id });
        }
        const scopes = requirement[scheme];
        if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
          invalid(schemePointer, `Scopes of security scheme "${scheme}" in operation "${id}" must be an array of strings; use [] for none.`);
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
      this.report("INVALID_MANIFEST", `${bindingPointer}/name`, `Name "${name.slice(0, 32)}…" derived for operation "${binding.id}" has ${name.length} characters; catalog names allow ${NAME_MAX_LENGTH}, so set a shorter manifest name.`, { source: "manifest", operation: binding.id });
    }
    const tags = this.member(op, "tags", entry.pointer, LIST, binding.id) ?? [];
    // A malformed operation-level list is reported and never falls back to the path item's servers.
    const operationServers = this.member(op, "servers", entry.pointer, LIST, binding.id);
    const pathServers = own(op, "servers") === undefined ? this.member(entry.pathItem, "servers", entry.pathItemPointer, LIST, binding.id) : undefined;
    tags.forEach((tag, index) => {
      if (typeof tag !== "string") this.report("INVALID_SPEC", `${entry.pointer}/tags/${index}`, `Tag ${index} of operation "${binding.id}" must be a string.`, { operation: binding.id });
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
        this.report("INVALID_SPEC", `${pointer}/type`, `Security scheme "${name}" needs a type of ${SECURITY_SCHEME_TYPES.join(", ")}.`);
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
          this.report("INVALID_SPEC", `${pointer}/${key}`, `Security scheme "${name}" of type ${value.type} needs ${need}.`);
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
            this.report("INVALID_SPEC", flowPointer, `OAuth flow "${flowName}" of security scheme "${name}" must be an object.`);
            continue;
          }
          const requiredUrls = own(OAUTH_FLOW_URLS, flowName) as (typeof OAUTH_FLOW_URLS)[string] | undefined;
          if (requiredUrls === undefined) {
            this.report("INVALID_SPEC", flowPointer, `OAuth flow "${flowName}" of security scheme "${name}" is not one of ${Object.keys(OAUTH_FLOW_URLS).join(", ")}.`);
          }
          const declaredScopes = this.member(flow, "scopes", flowPointer, OBJECT);
          if (own(flow, "scopes") === undefined) {
            this.report("INVALID_SPEC", `${flowPointer}/scopes`, `OAuth flow "${flowName}" of security scheme "${name}" needs scopes (an object, possibly empty).`);
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
              this.report("INVALID_SPEC", `${flowPointer}/${key}`, `OAuth flow "${flowName}" of security scheme "${name}" needs a non-empty ${key}.`);
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

  componentSchemas(): Record<string, JsonValue> {
    const components = this.schemaComponents;
    const output: Record<string, JsonValue> = {};
    // A component reached from a credential field is emitted without literals; a
    // component first emitted normally is re-emitted once that taint reaches it.
    // Each name is queued when first referenced and again when tainted, so a long chain is walked once.
    const emitted = new Map<string, boolean>();
    for (let next = 0; next < this.pendingComponents.length; next += 1) {
      const name = this.pendingComponents[next];
      const secret = this.componentRefs.get(name) === true;
      if (emitted.has(name) && (!secret || emitted.get(name))) continue;
      emitted.set(name, secret);
      this.identifier(name, `/components/schemas/${pointerSegment(name)}`, "Component schema name");
      const schema = this.schema(own(components, name), `/components/schemas/${pointerSegment(name)}`, secret);
      if (schema !== null) setOwn(output, name, schema);
    }
    return Object.fromEntries(Object.keys(output).sort(compareCodeUnits).map((name) => [name, output[name]]));
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
          this.report("INVALID_SPEC", variablePointer, `Server variable "${name}" at ${serverPointer} needs a string default.`);
          continue;
        }
        setOwn(defaults, name, variable.default);
        enums.set(name, this.member(variable, "enum", variablePointer, STRING_LIST) ?? null);
      }
      const valid = names.filter((name) => Object.hasOwn(defaults, name));
      // Judged against the original template: a variable with an occurrence in the removed user info, query or
      // fragment (or none left in the emitted URL) only fills a removed part, so its values may be credentials.
      const removed = (name: string) => {
        const placeholder = `{${name}}`;
        const kept = url.split(placeholder).length - 1;
        return kept === 0 || kept < template.split(placeholder).length - 1;
      };
      const hidden = new Set(valid.filter((name) => isCredentialKey(name) || removed(name)));
      // Values are judged in the URL expanded with all defaults, then with each enum value in turn (other variables at
      // their judged defaults), so values that only together form user info, a query or a fragment are caught.
      const cuts = new Set<string>();
      const judged: Record<string, string> = { ...defaults };
      for (const name of valid.filter((name) => !hidden.has(name))) {
        const verdict = judgeServerValue(template, defaults, name);
        if ("hide" in verdict) {
          verdict.hide.forEach((other) => hidden.add(other));
        } else if (verdict.cut) {
          setOwn(judged, name, verdict.value);
          cuts.add(`${name}/default`);
        }
      }
      const enumValues = new Map<string, string[]>();
      for (const name of valid.filter((name) => !hidden.has(name) && enums.get(name))) {
        enumValues.set(name, enums.get(name)!.map((entry, index) => {
          const verdict = judgeServerValue(template, { ...judged, [name]: entry }, name);
          if ("hide" in verdict) {
            verdict.hide.forEach((other) => hidden.add(other));
            return entry;
          }
          if (verdict.cut) cuts.add(`${name}/enum/${index}`);
          return verdict.value;
        }));
      }
      // Every combination of declared values, judged together: one variable's scheme and another's user info meet only there.
      const overflow = hideJointServerValues(template, valid, hidden, (name) =>
        hidden.has(name) ? [defaults[name], ...(enums.get(name) ?? [])] : [judged[name], ...(enumValues.get(name) ?? [])]
      );
      const variables: CatalogServer["variables"] = {};
      for (const name of valid) {
        const variable = declared[name] as Record<string, unknown>;
        const variablePointer = `${serverPointer}/variables/${pointerSegment(name)}`;
        const values = enums.get(name) ?? null;
        const hide = hidden.has(name);
        if (isCredentialKey(name)) {
          this.report("CREDENTIAL_REDACTED", variablePointer, `Replaced the values of credential-named server variable "${name}"; credentials never belong in server URLs.`, { severity: "warning" });
        } else if (hide) {
          const why = overflow
            ? `server variable "${name}" of ${serverPointer}/url, whose values have more than ${SERVER_COMBINATION_LIMIT} combinations to judge for user info, a query or a fragment`
            : `server variable "${name}" fills user info, a query or a fragment of ${serverPointer}/url, which the catalog removes`;
          this.report("CREDENTIAL_REDACTED", `${variablePointer}/default`, `Replaced the default of ${why}.`, { severity: "warning" });
          values?.forEach((_, valueIndex) => this.report("CREDENTIAL_REDACTED", `${variablePointer}/enum/${valueIndex}`, `Removed enum value ${valueIndex} of ${why}.`, { severity: "warning" }));
        }
        /** A value that put user info into the URL lost it; the rest is copied as text. */
        const value = (raw: string, field: string): string => {
          const valuePointer = `${variablePointer}/${field}`;
          if (cuts.has(`${name}/${field}`)) {
            this.report("CREDENTIAL_REDACTED", valuePointer, `Removed the user info that server variable "${name}" puts into the URL at ${serverPointer}/url; URLs never carry user info.`, { severity: "warning" });
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
        this.report("INVALID_SPEC", `/paths/${pointerSegment(path)}`, `Path "${path}" must start with "/".`);
        continue;
      }
      this.identifier(path, `/paths/${pointerSegment(path)}`, "Path template");
      const resolved = this.deref(paths[path], `/paths/${pointerSegment(path)}`);
      if (!resolved) continue;
      for (const method of METHODS) {
        const operation = own(resolved.value, method);
        if (operation === undefined) continue;
        if (!isRecord(operation)) {
          this.report("INVALID_SPEC", `/paths/${pointerSegment(path)}/${method}`, `Operation ${method.toUpperCase()} ${path} must be an object, not ${describeValue(operation)}.`);
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
        this.report("DUPLICATE_OPERATION_ID", `${entry.pointer}/operationId`, `OpenAPI operationId "${entry.operationId}" is used by both ${existing.method.toUpperCase()} ${existing.path} and ${entry.method.toUpperCase()} ${entry.path}.`);
      } else {
        byOperationId.set(entry.operationId, entry);
      }
    }

    const bound = new Map<SpecOperation, OperationBinding>();
    const stableIds = new Set<string>();
    this.manifest.operations.forEach((binding, index) => {
      const pointer = `/operations/${index}`;
      if (stableIds.has(binding.id)) {
        this.report("DUPLICATE_OPERATION_ID", `${pointer}/id`, `Stable operation ID "${binding.id}" is declared more than once in the manifest.`, { source: "manifest", operation: binding.id });
        return;
      }
      stableIds.add(binding.id);
      const entry = binding.operationId !== undefined
        ? byOperationId.get(binding.operationId)
        : byRoute.get(`${binding.method?.toLowerCase()} ${binding.path}`);
      if (!entry) {
        const target = binding.operationId !== undefined ? `operationId "${binding.operationId}"` : `${binding.method?.toUpperCase()} ${binding.path}`;
        this.report("UNMATCHED_OPERATION_BINDING", pointer, `Stable operation "${binding.id}" binds ${target}, which is not in the spec; update or remove the binding.`, { source: "manifest", operation: binding.id });
        return;
      }
      const previous = bound.get(entry);
      if (previous) {
        this.report("DUPLICATE_OPERATION_ID", pointer, `${entry.method.toUpperCase()} ${entry.path} is bound by both "${previous.id}" and "${binding.id}"; each operation needs exactly one stable ID.`, { source: "manifest", operation: binding.id });
        return;
      }
      bound.set(entry, binding);
    });

    const operations: CatalogOperation[] = [];
    for (const entry of specOperations) {
      const binding = bound.get(entry);
      if (!binding) {
        this.report("MISSING_OPERATION_ID", entry.pointer, `${entry.method.toUpperCase()} ${entry.path}${entry.operationId ? ` (operationId "${entry.operationId}")` : ""} has no stable operation ID; add a manifest binding.`);
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
        this.report("NAME_COLLISION", pointer, `Operations "${existing.id}" and "${operation.id}" resolve to colliding names "${existing.name}" and "${operation.name}"; set a distinct manifest name.`, { source: "manifest", operation: operation.id });
      } else {
        names.set(nameKey(operation.name), operation);
      }
      const replacement = operation.deprecation.replacement;
      if (replacement !== null && (replacement === operation.id || !operations.some((op) => op.id === replacement))) {
        this.report("UNKNOWN_REPLACEMENT", `${pointer}/deprecation/replacement`, `Operation "${operation.id}" names replacement "${replacement}", which is not another operation in this catalog.`, { source: "manifest", operation: operation.id });
      }
      if (operation.agent.expose && operation.executionPolicyRef === null) {
        this.report("AGENT_POLICY_REQUIRED", `${pointer}/agent/expose`, `Operation "${operation.id}" is exposed to agents without an executionPolicy reference; HTTP method and schema never imply authorization or idempotency.`, { source: "manifest", operation: operation.id });
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
    return `Cannot read the OpenAPI document: ${redactCredentialValues(reason.split("\n")[0]).slice(0, 200)}`;
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
  const input = typeof spec === "string" ? spec : plain(spec, "INVALID_SPEC", "spec");
  if (input !== null) {
    try {
      const parsed = parseOpenAPI(input as string | Record<string, unknown>);
      doc = (typeof spec === "string" ? plain(parsed, "INVALID_SPEC", "spec") : parsed) as Doc | null;
      if (doc && (!isRecord(doc.paths) || !isRecord(doc.info))) throw new Error("document requires info and paths objects");
      if (doc) specDigest = canonicalDigest(doc);
    } catch (error) {
      doc = null;
      diagnostics.push({ code: "INVALID_SPEC", severity: "error", message: parseFailure(error), pointer: "", source: "spec" });
    }
  }

  const manifestData = plain(manifest, "INVALID_MANIFEST", "manifest");
  const validated = manifestData === null ? { manifest: null, diagnostics: [] } : validateManifest(manifestData);
  diagnostics.push(...validated.diagnostics);
  let manifestDigest = "";
  if (validated.manifest) {
    try {
      manifestDigest = canonicalDigest(validated.manifest);
    } catch {
      diagnostics.push({ code: "INVALID_MANIFEST", severity: "error", message: "The manifest must be plain JSON data (no class instances, Maps or non-finite numbers).", pointer: "", source: "manifest" });
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
