import { parseOpenAPI } from "@apifn/core";
import { canonicalDigest, canonicalJson, compareCodeUnits, MAX_JSON_DEPTH, snapshotPlainData } from "./canonical.js";
import {
  containsCredentialIdentifier,
  containsCredentialValue,
  hasUrlUserInfo,
  isCredentialKey,
  pointerSegment,
  REDACTED,
  redactCredentialValues,
  sanitizePointer,
  sanitizeReport,
  stripUrlCredentials,
} from "./credentials.js";
import { isSupportedMediaType, normalizeMediaType, validateManifest } from "./manifest.js";
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
  "type", "format", "title", "description", "$comment", "$id", "$schema", "$anchor", "$dynamicAnchor", "$dynamicRef",
  "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern",
  "maxItems", "minItems", "uniqueItems", "maxContains", "minContains", "maxProperties", "minProperties",
  "nullable", "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType", "discriminator",
  ...NAME_KEYWORDS, ...OBJECT_KEYWORDS,
]);
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

/** True when JSON data holds a credential-named or credential-bearing key at any depth. */
function hasCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialKey);
  return isRecord(value) && Object.entries(value).some(([key, child]) => isCredentialMember(key) || hasCredentialKey(child));
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

/** A server variable value without user info: everything up to its last "@". */
function withoutUserInfo(value: string): string {
  return value.slice(value.lastIndexOf("@") + 1);
}

/** Expands `{name}` server variables; undeclared ones stay as written. */
function expandServerUrl(url: string, values: Record<string, string>): string {
  return url.replace(/\{([^{}]*)\}/g, (placeholder, name: string) => (Object.hasOwn(values, name) ? values[name] : placeholder));
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
      } else if (key === "$ref") {
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
      } else if (hasCredentialKey(child)) {
        drop(key, childPointer, "it holds credential-named keys");
      } else {
        setOwn(output, key, this.data(OBJECT_KEYWORDS.has(key) ? withoutExtensions(child) : child, childPointer));
      }
    }
    return output;
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
    this.componentRefs.set(name, this.componentRefs.get(name) === true || secret);
    return `${COMPONENT_SCHEMA_PREFIX}${refSegment(name)}`;
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
      this.componentRefs.set(name, this.componentRefs.get(name) === true || secret);
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
      if (!this.mediaTypes.has(mediaType)) {
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
      const listable = unsupported.filter((rawType) => isSupportedMediaType(normalizeMediaType(rawType)));
      // Only media types the catalog can describe may be added to the manifest; others need a spec change.
      const advice = listable.length > 0
        ? `add a media type the manifest lists (${allowed}) or add ${sortStrings(listable.map(normalizeMediaType)).join(", ")} to manifest serialization.mediaTypes`
        : `the catalog cannot describe ${unsupported.join(", ")}, so the spec must also offer one of ${allowed}`;
      this.report(
        "UNSUPPORTED_SERIALIZATION",
        pointer,
        byType.size === 0
          ? `${what} of operation "${operation}" only offers ${unsupported.join(", ")}; ${advice}.`
          : `${what} of operation "${operation}" drops unsupported media types ${unsupported.join(", ")}; clients use ${allowed}.`,
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
      const bearerFormat = this.text(own(value, "bearerFormat"), `${pointer}/bearerFormat`);
      if (bearerFormat !== null) scheme.bearerFormat = bearerFormat;
      const openIdConnectUrl = this.url(own(value, "openIdConnectUrl"), `${pointer}/openIdConnectUrl`);
      if (openIdConnectUrl !== null) scheme.openIdConnectUrl = openIdConnectUrl;
      const declaredFlows = this.member(value, "flows", pointer, OBJECT);
      if (declaredFlows !== undefined) {
        const flows: NonNullable<CatalogSecurityScheme["flows"]> = {};
        for (const flowName of Object.keys(declaredFlows).sort(compareCodeUnits)) {
          const flow = declaredFlows[flowName];
          const flowPointer = `${pointer}/flows/${pointerSegment(flowName)}`;
          this.identifier(flowName, flowPointer, "OAuth flow name");
          if (!isRecord(flow)) {
            this.report("INVALID_SPEC", flowPointer, `OAuth flow "${flowName}" of security scheme "${name}" must be an object.`);
            continue;
          }
          const scopes = Object.keys(this.member(flow, "scopes", flowPointer, OBJECT) ?? {});
          const output: NonNullable<CatalogSecurityScheme["flows"]>[string] = {
            scopes: sortStrings(scopes.map((scope) => this.identifier(scope, `${flowPointer}/scopes/${pointerSegment(scope)}`, "Scope name"))),
          };
          for (const key of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
            const url = this.url(own(flow, key), `${flowPointer}/${key}`);
            if (url !== null) output[key] = url;
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
    const emitted = new Map<string, boolean>();
    for (;;) {
      const pending = Array.from(this.componentRefs).filter(([name, secret]) => !emitted.has(name) || (secret && !emitted.get(name)));
      if (pending.length === 0) break;
      for (const [name, secret] of pending) {
        emitted.set(name, secret);
        this.identifier(name, `/components/schemas/${pointerSegment(name)}`, "Component schema name");
        const schema = this.schema(own(components, name), `/components/schemas/${pointerSegment(name)}`, secret);
        if (schema !== null) setOwn(output, name, schema);
      }
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
      const url = this.url(server.url, `${serverPointer}/url`, { dropQuery: true }) as string;
      const variables: CatalogServer["variables"] = {};
      const declared = this.member(server, "variables", serverPointer, OBJECT) ?? {};
      // Other variables expand to their defaults without user info, so a value is judged only by the user info it adds itself.
      const neutral: Record<string, string> = {};
      for (const [name, variable] of Object.entries(declared)) {
        if (isRecord(variable) && typeof variable.default === "string") setOwn(neutral, name, withoutUserInfo(variable.default));
      }
      /** A variable value that puts user info into the expanded URL (`svc:pw@host` as `{authority}`) loses it. */
      const value = (name: string, raw: string, valuePointer: string): string => {
        if (!hasUrlUserInfo(expandServerUrl(url, { ...neutral, [name]: raw }))) return this.text(raw, valuePointer) as string;
        this.report("CREDENTIAL_REDACTED", valuePointer, `Removed the user info that server variable "${name}" puts into the URL at ${serverPointer}/url; URLs never carry user info.`, { severity: "warning" });
        return this.text(withoutUserInfo(raw), valuePointer) as string;
      };
      for (const name of Object.keys(declared).sort(compareCodeUnits)) {
        const variable = declared[name];
        const variablePointer = `${serverPointer}/variables/${pointerSegment(name)}`;
        this.identifier(name, variablePointer, "Server variable name");
        if (!isRecord(variable) || typeof variable.default !== "string") {
          this.report("INVALID_SPEC", variablePointer, `Server variable "${name}" at ${serverPointer} needs a string default.`);
          continue;
        }
        if (isCredentialKey(name)) {
          this.report("CREDENTIAL_REDACTED", variablePointer, `Replaced the values of credential-named server variable "${name}"; credentials never belong in server URLs.`, { severity: "warning" });
        }
        const values = this.member(variable, "enum", variablePointer, STRING_LIST) ?? null;
        setOwn(variables, name, {
          default: isCredentialKey(name) ? REDACTED : value(name, variable.default, `${variablePointer}/default`),
          enum: values && !isCredentialKey(name) ? values.map((entry, valueIndex) => value(name, entry, `${variablePointer}/enum/${valueIndex}`)) : null,
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
        if (!isRecord(operation)) continue;
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
