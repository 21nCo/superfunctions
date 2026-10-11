import { parseOpenAPI } from "@apifn/core";
import { canonicalDigest, canonicalJson, compareCodeUnits } from "./canonical.js";
import { isCredentialKey, REDACTED, redactCredentialValues, stripUrlCredentials } from "./credentials.js";
import { normalizeMediaType, validateManifest } from "./manifest.js";
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

/** True when JSON data holds a credential-named key at any depth. */
function hasCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialKey);
  return isRecord(value) && Object.entries(value).some(([key, child]) => isCredentialKey(key) || hasCredentialKey(child));
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
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

function toIdentifier(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `op${name.charAt(0).toUpperCase()}${name.slice(1)}`;
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

  constructor(
    private readonly doc: Doc,
    private readonly manifest: ApiManifest
  ) {
    this.mediaTypes = new Set((manifest.serialization?.mediaTypes ?? ["application/json"]).map(normalizeMediaType));
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

  /** Copies author text, redacting recognizable credentials. */
  text(value: unknown, pointer: string, source: Diagnostic["source"] = "spec"): string | null {
    if (typeof value !== "string") return null;
    const redacted = redactCredentialValues(value);
    if (redacted !== value) {
      this.report("CREDENTIAL_REDACTED", pointer, `Removed a credential-like value from ${pointer}; credentials never belong in API descriptions.`, { severity: "warning", source });
    }
    return redacted;
  }

  /** Copies a URL without user info, credential query parameters or fragment (`dropQuery` removes the whole query). */
  url(value: unknown, pointer: string, options: { source?: Diagnostic["source"]; dropQuery?: boolean } = {}): string | null {
    if (typeof value !== "string") return null;
    const source = options.source ?? "spec";
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
  private checkRef(value: Record<string, unknown>, pointer: string): boolean {
    if (!Object.hasOwn(value, "$ref")) return false;
    const ref = value.$ref;
    const shown = typeof ref === "string" ? redactCredentialValues(ref) : "";
    if (typeof ref !== "string") {
      this.report("UNRESOLVED_REF", `${pointer}/$ref`, "A $ref value must be a string.");
    } else if (!ref.startsWith("#")) {
      this.report("UNRESOLVED_REF", `${pointer}/$ref`, `External reference "${shown}" is not supported; bundle external documents into the spec before building the catalog.`);
    } else if (resolvePointer(this.doc, ref) === undefined) {
      this.report("UNRESOLVED_REF", `${pointer}/$ref`, `Reference "${shown}" does not resolve to a value in the spec.`);
    }
    return true;
  }

  private walkMap(value: unknown, pointer: string, walk: (entry: unknown, pointer: string) => void, skipExtensions = false): void {
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (!(skipExtensions && key.startsWith("x-"))) walk(entry, `${pointer}/${escapePointer(key)}`);
    }
  }

  private walkList(value: unknown, pointer: string, walk: (entry: unknown, pointer: string) => void): void {
    if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${pointer}/${index}`));
  }

  /** Walks schema keywords only: property names are never keywords and literal data is never a reference. */
  private walkSchema(value: unknown, pointer: string): void {
    if (!isRecord(value)) return;
    this.checkRef(value, pointer);
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
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
    if (!isRecord(value) || this.checkRef(value, pointer)) return;
    this.walkSchema(value.schema, `${pointer}/schema`);
    this.walkContent(value.content, `${pointer}/content`);
  }

  private walkRequestBody(value: unknown, pointer: string): void {
    if (isRecord(value) && !this.checkRef(value, pointer)) this.walkContent(value.content, `${pointer}/content`);
  }

  private walkResponse(value: unknown, pointer: string): void {
    if (!isRecord(value) || this.checkRef(value, pointer)) return;
    this.walkMap(value.headers, `${pointer}/headers`, (header, headerPointer) => this.walkParameter(header, headerPointer));
    this.walkContent(value.content, `${pointer}/content`);
  }

  private walkCallback(value: unknown, pointer: string): void {
    if (isRecord(value) && !this.checkRef(value, pointer)) {
      this.walkMap(value, pointer, (item, itemPointer) => this.walkPathItem(item, itemPointer), true);
    }
  }

  private walkPathItem(value: unknown, pointer: string): void {
    if (!isRecord(value) || this.checkRef(value, pointer)) return;
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
      securitySchemes: (entry, pointer) => void (isRecord(entry) && this.checkRef(entry, pointer)),
    };
    for (const [section, walk] of Object.entries(walkers)) {
      this.walkMap(own(components, section), `/components/${section}`, walk);
    }
  }

  deref(value: unknown, pointer: string): { value: Record<string, unknown>; pointer: string } | null {
    let current = value;
    let currentPointer = pointer;
    for (let hops = 0; hops < 32; hops += 1) {
      if (!isRecord(current)) return null;
      if (typeof current.$ref !== "string") return { value: current, pointer: currentPointer };
      currentPointer = current.$ref.slice(1);
      current = resolvePointer(this.doc, current.$ref);
    }
    this.report("UNRESOLVED_REF", pointer, `Reference chain at ${pointer} is cyclic or longer than 32 hops.`);
    return null;
  }

  /**
   * Copies a schema without examples or extensions. Inside a credential field
   * (a credential-named property or parameter, `format: password`, or any
   * subschema, applicator or component reached from one) literal values are
   * dropped, as are literals that hold credential-named keys.
   */
  schema(value: unknown, pointer: string, credential = false): JsonValue | null {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (!isRecord(value)) return null;
    const secret = credential || value.format === "password";
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (key === "example" || key === "examples" || key.startsWith("x-")) continue;
      if (LITERAL_KEYWORDS.has(key) && (secret || hasCredentialKey(child))) {
        this.report("CREDENTIAL_REDACTED", childPointer, `Dropped the literal "${key}" at ${childPointer} because it belongs to or contains a credential field.`, { severity: "warning" });
        continue;
      }
      if (key === "$ref" && typeof child === "string") {
        if (child.startsWith(COMPONENT_SCHEMA_PREFIX)) {
          const name = decodePointerSegment(child.slice(COMPONENT_SCHEMA_PREFIX.length).split("/")[0]);
          this.componentRefs.set(name, this.componentRefs.get(name) === true || secret);
        } else if (resolvePointer(this.doc, child) !== undefined) {
          this.report("UNRESOLVED_REF", childPointer, `Schema reference "${child}" must target ${COMPONENT_SCHEMA_PREFIX}<name> so generated clients can share the type.`);
        }
        setOwn(output, key, child);
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(child)) {
        const entries: Record<string, JsonValue> = {};
        const named = key === "properties" || key === "patternProperties";
        for (const [name, entry] of Object.entries(child)) {
          const nested = this.schema(entry, `${childPointer}/${escapePointer(name)}`, secret || (named && isCredentialKey(name)));
          if (nested !== null) setOwn(entries, name, nested);
        }
        setOwn(output, key, entries);
      } else if (SCHEMA_KEYWORDS.has(key)) {
        const nested = this.schema(child, childPointer, secret);
        if (nested !== null) setOwn(output, key, nested);
      } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(child)) {
        setOwn(output, key, child.map((entry, index) => this.schema(entry, `${childPointer}/${index}`, secret) ?? {}));
      } else if (key === "pattern" && typeof child === "string") {
        setOwn(output, key, child); // A regular expression, not author text; redaction would change its meaning.
      } else {
        setOwn(output, key, this.data(child, childPointer));
      }
    }
    return output;
  }

  data(value: unknown, pointer: string): JsonValue {
    if (typeof value === "string") return this.text(value, pointer) ?? "";
    if (Array.isArray(value)) return value.map((item, index) => this.data(item, `${pointer}/${index}`));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !key.startsWith("x-"))
          .map(([key, child]) => [key, this.data(child, `${pointer}/${escapePointer(key)}`)])
      );
    }
    return value === undefined ? null : (value as JsonValue);
  }

  encoding(media: Record<string, unknown>, pointer: string, mediaType: string, operation: string): Record<string, CatalogEncoding> {
    const output: Record<string, CatalogEncoding> = {};
    if (!FORM_MEDIA_TYPES.has(mediaType) || !isRecord(media.encoding)) return output;
    for (const name of Object.keys(media.encoding).sort(compareCodeUnits)) {
      const encoding = media.encoding[name];
      const encodingPointer = `${pointer}/encoding/${escapePointer(name)}`;
      if (!isRecord(encoding)) continue;
      const style = typeof encoding.style === "string" ? encoding.style : "form";
      if (!PARAMETER_STYLES.query.includes(style)) {
        this.report("UNSUPPORTED_SERIALIZATION", `${encodingPointer}/style`, `Property "${name}" of ${mediaType} in operation "${operation}" uses style "${style}"; supported styles are ${PARAMETER_STYLES.query.join(", ")}.`, { operation });
        continue;
      }
      if (encoding.headers !== undefined) {
        this.report("UNSUPPORTED_SERIALIZATION", `${encodingPointer}/headers`, `Part headers of property "${name}" in operation "${operation}" are not described in the catalog; generated clients will not send them.`, { severity: "warning", operation });
      }
      setOwn(output, name, {
        contentType: this.text(encoding.contentType, `${encodingPointer}/contentType`),
        style,
        explode: typeof encoding.explode === "boolean" ? encoding.explode : style === "form",
        allowReserved: encoding.allowReserved === true,
      });
    }
    return output;
  }

  contents(content: unknown, pointer: string, operation: string, what: string): CatalogContent[] {
    if (!isRecord(content)) return [];
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
      const mediaPointer = `${pointer}/${escapePointer(rawType)}`;
      const entry: CatalogContent = isRecord(media)
        ? { mediaType, schema: this.schema(media.schema, `${mediaPointer}/schema`), encoding: this.encoding(media, mediaPointer, mediaType, operation) }
        : { mediaType, schema: null, encoding: {} };
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
      this.report(
        "UNSUPPORTED_SERIALIZATION",
        pointer,
        byType.size === 0
          ? `${what} of operation "${operation}" only offers ${unsupported.join(", ")}; add a supported media type (${allowed}) or extend manifest serialization.mediaTypes.`
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
      if (!Array.isArray(list)) continue;
      list.forEach((raw, index) => {
        const resolved = this.deref(raw, `${pointer}/${index}`);
        if (!resolved) return; // Dangling references are reported by checkRefs.
        const { name, in: location } = resolved.value;
        if (typeof name !== "string" || name === "" || !PARAMETER_LOCATIONS.includes(location as CatalogParameter["in"])) {
          this.report("INVALID_SPEC", resolved.pointer, `Parameter at ${resolved.pointer} of operation "${id}" needs a name and an "in" of ${PARAMETER_LOCATIONS.join(", ")}.`, { operation: id });
          return;
        }
        merged.set(`${location}:${name}`, resolved);
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
      const style = typeof value.style === "string" ? value.style : location === "query" || location === "cookie" ? "form" : "simple";
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
      parameters.push({
        name,
        in: location,
        required: location === "path" ? true : value.required === true,
        deprecated: value.deprecated === true,
        style,
        explode: typeof value.explode === "boolean" ? value.explode : style === "form",
        allowReserved: value.allowReserved === true,
        description: this.text(value.description, `${pointer}/description`),
        schema: this.schema(value.schema, `${pointer}/schema`, isCredentialKey(name)),
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
    const responses = entry.operation.responses;
    if (!isRecord(responses)) return [];
    return Object.keys(responses)
      .sort(compareCodeUnits)
      .flatMap((status) => {
        if (status.startsWith("x-")) return [];
        if (!RESPONSE_STATUS.test(status)) {
          this.report("INVALID_SPEC", `${entry.pointer}/responses/${escapePointer(status)}`, `Response key "${status}" of operation "${id}" is not an HTTP status, a 1XX-5XX range or "default".`, { operation: id });
          return [];
        }
        const resolved = this.deref(responses[status], `${entry.pointer}/responses/${escapePointer(status)}`);
        if (!resolved) return [];
        const kind: CatalogResponse["kind"] = status === "default" ? "default" : /^[45]/.test(status) ? "error" : "success";
        return [
          {
            status,
            kind,
            description: this.text(resolved.value.description, `${resolved.pointer}/description`) ?? "",
            contents: this.contents(resolved.value.content, `${resolved.pointer}/content`, id, `Response ${status}`),
          },
        ];
      });
  }

  security(entry: SpecOperation, id: string): SecurityRequirementTerm[][] {
    const declared = Array.isArray(entry.operation.security) ? entry.operation.security : this.doc.security;
    const pointer = Array.isArray(entry.operation.security) ? `${entry.pointer}/security` : "/security";
    const schemes = isRecord(this.doc.components) && isRecord(this.doc.components.securitySchemes)
      ? this.doc.components.securitySchemes
      : {};
    const alternatives = new Map<string, SecurityRequirementTerm[]>();
    (Array.isArray(declared) ? declared : []).forEach((requirement, index) => {
      if (!isRecord(requirement)) return;
      const terms = Object.keys(requirement)
        .sort(compareCodeUnits)
        .map((scheme) => {
          if (!Object.prototype.hasOwnProperty.call(schemes, scheme)) {
            this.report("UNKNOWN_SECURITY_SCHEME", `${pointer}/${index}/${escapePointer(scheme)}`, `Operation "${id}" requires security scheme "${scheme}", which is not declared in components.securitySchemes.`, { operation: id });
          }
          const scopes = requirement[scheme];
          return { scheme, scopes: sortStrings(Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : []) };
        });
      alternatives.set(canonicalJson(terms), terms);
    });
    if (alternatives.size === 0) return [[]];
    return Array.from(alternatives.keys())
      .sort(compareCodeUnits)
      .map((key) => alternatives.get(key) as SecurityRequirementTerm[]);
  }

  operation(entry: SpecOperation, binding: OperationBinding): CatalogOperation {
    const op = entry.operation;
    const deprecated = op.deprecated === true || binding.deprecation !== undefined;
    const requestBody = this.deref(op.requestBody, `${entry.pointer}/requestBody`);
    const bindingPointer = `/operations/${this.manifest.operations.indexOf(binding)}`;
    return {
      id: binding.id,
      name: binding.name ?? toIdentifier(entry.operationId ?? binding.id),
      openapiOperationId: entry.operationId,
      method: entry.method,
      path: entry.path,
      summary: this.text(op.summary, `${entry.pointer}/summary`),
      description: this.text(op.description, `${entry.pointer}/description`),
      tags: sortStrings(Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : []),
      parameters: this.parameters(entry, binding.id),
      requestBody: requestBody
        ? {
            required: requestBody.value.required === true,
            contents: this.contents(requestBody.value.content, `${requestBody.pointer}/content`, binding.id, "Request body"),
          }
        : null,
      responses: this.responses(entry, binding.id),
      servers: Array.isArray(op.servers)
        ? this.servers(op.servers, `${entry.pointer}/servers`)
        : Array.isArray(entry.pathItem.servers)
          ? this.servers(entry.pathItem.servers, `${entry.pathItemPointer}/servers`)
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
    const components = isRecord(this.doc.components) ? this.doc.components : {};
    const declared = isRecord(components.securitySchemes) ? components.securitySchemes : {};
    const output: Record<string, CatalogSecurityScheme> = {};
    for (const name of Object.keys(declared).sort(compareCodeUnits)) {
      const resolved = this.deref(declared[name], `/components/securitySchemes/${escapePointer(name)}`);
      if (!resolved || typeof resolved.value.type !== "string") continue;
      const { value, pointer } = resolved;
      const scheme: CatalogSecurityScheme = { type: value.type as string, description: this.text(value.description, `${pointer}/description`) };
      for (const key of ["scheme", "bearerFormat", "in", "name"] as const) {
        if (typeof value[key] === "string") scheme[key] = value[key] as string;
      }
      if (typeof value.openIdConnectUrl === "string") {
        scheme.openIdConnectUrl = this.url(value.openIdConnectUrl, `${pointer}/openIdConnectUrl`) ?? undefined;
      }
      if (isRecord(value.flows)) {
        const flows: NonNullable<CatalogSecurityScheme["flows"]> = {};
        for (const flowName of Object.keys(value.flows).sort(compareCodeUnits)) {
          const flow = value.flows[flowName];
          if (!isRecord(flow)) continue;
          const flowPointer = `${pointer}/flows/${escapePointer(flowName)}`;
          const output: NonNullable<CatalogSecurityScheme["flows"]>[string] = { scopes: sortStrings(isRecord(flow.scopes) ? Object.keys(flow.scopes) : []) };
          for (const key of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
            if (typeof flow[key] === "string") output[key] = this.url(flow[key], `${flowPointer}/${key}`) ?? undefined;
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
    const components = isRecord(this.doc.components) && isRecord(this.doc.components.schemas) ? this.doc.components.schemas : {};
    const output: Record<string, JsonValue> = {};
    // A component reached from a credential field is emitted without literals; a
    // component first emitted normally is re-emitted once that taint reaches it.
    const emitted = new Map<string, boolean>();
    for (;;) {
      const pending = Array.from(this.componentRefs).filter(([name, secret]) => !emitted.has(name) || (secret && !emitted.get(name)));
      if (pending.length === 0) break;
      for (const [name, secret] of pending) {
        emitted.set(name, secret);
        const schema = this.schema(own(components, name), `/components/schemas/${escapePointer(name)}`, secret);
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
      const variables: CatalogServer["variables"] = {};
      const declared = isRecord(server.variables) ? server.variables : {};
      for (const name of Object.keys(declared).sort(compareCodeUnits)) {
        const variable = declared[name];
        const variablePointer = `${serverPointer}/variables/${escapePointer(name)}`;
        if (!isRecord(variable) || typeof variable.default !== "string") {
          this.report("INVALID_SPEC", variablePointer, `Server variable "${name}" at ${serverPointer} needs a string default.`);
          continue;
        }
        if (isCredentialKey(name)) {
          this.report("CREDENTIAL_REDACTED", variablePointer, `Replaced the values of credential-named server variable "${name}"; credentials never belong in server URLs.`, { severity: "warning" });
        }
        const values = Array.isArray(variable.enum) ? variable.enum.filter((value): value is string => typeof value === "string") : null;
        setOwn(variables, name, {
          default: isCredentialKey(name) ? REDACTED : (this.text(variable.default, `${variablePointer}/default`) as string),
          enum: values && !isCredentialKey(name) ? values.map((value, valueIndex) => this.text(value, `${variablePointer}/enum/${valueIndex}`) as string) : null,
          description: this.text(variable.description, `${variablePointer}/description`),
        });
      }
      return [{
        url: this.url(server.url, `${serverPointer}/url`, { dropQuery: true }) as string,
        description: this.text(server.description, `${serverPointer}/description`),
        variables,
      }];
    });
  }

  specOperations(): SpecOperation[] {
    const paths = isRecord(this.doc.paths) ? this.doc.paths : {};
    const operations: SpecOperation[] = [];
    for (const path of Object.keys(paths).sort(compareCodeUnits)) {
      if (path.startsWith("x-")) continue;
      if (!path.startsWith("/")) {
        this.report("INVALID_SPEC", `/paths/${escapePointer(path)}`, `Path "${path}" must start with "/".`);
        continue;
      }
      const resolved = this.deref(paths[path], `/paths/${escapePointer(path)}`);
      if (!resolved) continue;
      for (const method of METHODS) {
        const operation = own(resolved.value, method);
        if (!isRecord(operation)) continue;
        operations.push({
          method,
          path,
          pointer: `/paths/${escapePointer(path)}/${method}`,
          pathItem: resolved.value,
          pathItemPointer: resolved.pointer,
          operation,
          operationId: typeof operation.operationId === "string" ? operation.operationId : null,
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

    const info = isRecord(this.doc.info) ? this.doc.info : {};
    const provenance = this.manifest.provenance ?? {};
    return {
      catalogVersion: CATALOG_VERSION,
      api: { id: this.manifest.api.id, version: this.manifest.api.version, title: this.text(info.title, "/info/title") ?? "" },
      provenance: {
        source: this.url(provenance.source, "/provenance/source", { source: "manifest" }),
        revision: this.text(provenance.revision, "/provenance/revision", "manifest"),
        exporter: this.text(provenance.exporter, "/provenance/exporter", "manifest"),
      },
      serialization: { mediaTypes: sortStrings(this.mediaTypes) },
      servers: this.servers(Array.isArray(this.doc.servers) ? this.doc.servers : [], "/servers"),
      securitySchemes: this.securitySchemes(),
      operations,
      schemas: this.componentSchemas(),
    };
  }
}

const SEVERITY_ORDER = { error: 0, warning: 1 } as const;

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const unique = new Map(diagnostics.map((diagnostic) => [canonicalJson(diagnostic), diagnostic]));
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
  let doc: Doc | null = null;
  let specDigest = "";
  try {
    doc = parseOpenAPI(spec) as unknown as Doc;
    if (!isRecord(doc.paths) || !isRecord(doc.info)) throw new Error("document requires info and paths objects");
    specDigest = canonicalDigest(doc);
  } catch (error) {
    doc = null;
    const reason = error instanceof Error ? error.message : String(error);
    diagnostics.push({ code: "INVALID_SPEC", severity: "error", message: `Cannot read the OpenAPI document: ${reason}`, pointer: "", source: "spec" });
  }

  const validated = validateManifest(manifest);
  diagnostics.push(...validated.diagnostics);
  if (!doc || !validated.manifest) {
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
    canonicalJson({ ...built, source: { specDigest, manifestDigest: canonicalDigest(validated.manifest), provenance } })
  ) as OperationCatalog;
  return { catalog, digest: canonicalDigest(catalog), diagnostics: sorted };
}
