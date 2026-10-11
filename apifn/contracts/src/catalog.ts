import { parseOpenAPI } from "@apifn/core";
import { canonicalDigest, canonicalJson, compareCodeUnits } from "./canonical.js";
import { isCredentialKey, redactCredentialValues, stripUrlCredentials } from "./credentials.js";
import { normalizeMediaType, validateManifest } from "./manifest.js";
import {
  CATALOG_VERSION,
  type ApiManifest,
  type BuildCatalogResult,
  type CatalogContent,
  type CatalogOperation,
  type CatalogParameter,
  type CatalogResponse,
  type CatalogSecurityScheme,
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
/** Schema data keywords that may carry literal values; dropped for credential-named fields. */
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
  operation: Record<string, unknown>;
  operationId: string | null;
}

class CatalogBuilder {
  readonly diagnostics: Diagnostic[] = [];
  private readonly componentRefs = new Set<string>();
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

  url(value: unknown, pointer: string, source: Diagnostic["source"] = "spec"): string | null {
    if (typeof value !== "string") return null;
    const stripped = stripUrlCredentials(value);
    if (stripped !== value) {
      this.report("CREDENTIAL_REDACTED", pointer, `Removed user info, query or fragment from the URL at ${pointer}.`, { severity: "warning", source });
    }
    return this.text(stripped, pointer, source);
  }

  checkRefs(value: unknown, pointer: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.checkRefs(item, `${pointer}/${index}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      // Examples and extensions never reach the catalog, so their payloads are not references.
      if (key === "example" || key === "examples" || key.startsWith("x-")) continue;
      if (key === "$ref" && typeof child === "string") {
        if (!child.startsWith("#")) {
          this.report("UNRESOLVED_REF", `${pointer}/$ref`, `External reference "${child}" is not supported; bundle external documents into the spec before building the catalog.`);
        } else if (resolvePointer(this.doc, child) === undefined) {
          this.report("UNRESOLVED_REF", `${pointer}/$ref`, `Reference "${child}" does not resolve to a value in the spec.`);
        }
      } else {
        this.checkRefs(child, `${pointer}/${escapePointer(key)}`);
      }
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

  schema(value: unknown, pointer: string, credentialField = false): JsonValue | null {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (!isRecord(value)) return null;
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (key === "example" || key === "examples" || key.startsWith("x-")) continue;
      if (credentialField && LITERAL_KEYWORDS.has(key)) continue;
      if (key === "$ref" && typeof child === "string") {
        if (child.startsWith(COMPONENT_SCHEMA_PREFIX)) {
          this.componentRefs.add(decodePointerSegment(child.slice(COMPONENT_SCHEMA_PREFIX.length).split("/")[0]));
        } else if (resolvePointer(this.doc, child) !== undefined) {
          this.report("UNRESOLVED_REF", childPointer, `Schema reference "${child}" must target ${COMPONENT_SCHEMA_PREFIX}<name> so generated clients can share the type.`);
        }
        output[key] = child;
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(child)) {
        const entries: Record<string, JsonValue> = {};
        for (const [name, entry] of Object.entries(child)) {
          const nested = this.schema(entry, `${childPointer}/${escapePointer(name)}`, key === "properties" && isCredentialKey(name));
          if (nested !== null) entries[name] = nested;
        }
        output[key] = entries;
      } else if (SCHEMA_KEYWORDS.has(key)) {
        const nested = this.schema(child, childPointer);
        if (nested !== null) output[key] = nested;
      } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(child)) {
        output[key] = child.map((entry, index) => this.schema(entry, `${childPointer}/${index}`) ?? {});
      } else if (key === "pattern" && typeof child === "string") {
        output[key] = child; // A regular expression, not author text; redaction would change its meaning.
      } else {
        output[key] = this.data(child, childPointer);
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

  contents(content: unknown, pointer: string, operation: string, what: string): CatalogContent[] {
    if (!isRecord(content)) return [];
    const supported: CatalogContent[] = [];
    const unsupported: string[] = [];
    for (const [rawType, media] of Object.entries(content)) {
      const mediaType = normalizeMediaType(rawType);
      if (!this.mediaTypes.has(mediaType)) {
        unsupported.push(rawType);
        continue;
      }
      const mediaPointer = `${pointer}/${escapePointer(rawType)}`;
      supported.push({ mediaType, schema: isRecord(media) ? this.schema(media.schema, `${mediaPointer}/schema`) : null });
    }
    if (unsupported.length > 0) {
      const allowed = Array.from(this.mediaTypes).join(", ");
      this.report(
        "UNSUPPORTED_SERIALIZATION",
        pointer,
        supported.length === 0
          ? `${what} of operation "${operation}" only offers ${unsupported.join(", ")}; add a supported media type (${allowed}) or extend manifest serialization.mediaTypes.`
          : `${what} of operation "${operation}" drops unsupported media types ${unsupported.join(", ")}; clients use ${allowed}.`,
        { severity: supported.length === 0 ? "error" : "warning", operation }
      );
    }
    return supported.sort((a, b) => compareCodeUnits(a.mediaType, b.mediaType));
  }

  parameters(entry: SpecOperation, id: string): CatalogParameter[] {
    const merged = new Map<string, { value: Record<string, unknown>; pointer: string }>();
    const sources: Array<[unknown, string]> = [
      [entry.pathItem.parameters, `/paths/${escapePointer(entry.path)}/parameters`],
      [entry.operation.parameters, `${entry.pointer}/parameters`],
    ];
    for (const [list, pointer] of sources) {
      if (!Array.isArray(list)) continue;
      list.forEach((raw, index) => {
        const resolved = this.deref(raw, `${pointer}/${index}`);
        if (resolved && typeof resolved.value.name === "string" && typeof resolved.value.in === "string") {
          merged.set(`${resolved.value.in}:${resolved.value.name}`, resolved);
        }
      });
    }

    const parameters: CatalogParameter[] = [];
    for (const { value, pointer } of merged.values()) {
      const location = value.in as CatalogParameter["in"];
      const name = value.name as string;
      if (!PARAMETER_LOCATIONS.includes(location)) continue;
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
        description: this.text(value.description, `${pointer}/description`),
        schema: this.schema(value.schema, `${pointer}/schema`, isCredentialKey(name)),
      });
    }
    // Path parameters keep template order so generated clients get stable positional arguments.
    const template = Array.from(entry.path.matchAll(/\{([^}]+)\}/g), (match) => match[1]);
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
          flows[flowName] = { scopes: sortStrings(isRecord(flow.scopes) ? Object.keys(flow.scopes) : []) };
          for (const key of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
            if (typeof flow[key] === "string") flows[flowName][key] = this.url(flow[key], `${flowPointer}/${key}`) ?? undefined;
          }
        }
        scheme.flows = flows;
      }
      output[name] = scheme;
    }
    return output;
  }

  componentSchemas(): Record<string, JsonValue> {
    const components = isRecord(this.doc.components) && isRecord(this.doc.components.schemas) ? this.doc.components.schemas : {};
    const output: Record<string, JsonValue> = {};
    const visited = new Set<string>();
    let pending = Array.from(this.componentRefs);
    while (pending.length > 0) {
      for (const name of pending) {
        visited.add(name);
        const schema = this.schema(components[name], `/components/schemas/${escapePointer(name)}`);
        if (schema !== null) output[name] = schema;
      }
      pending = Array.from(this.componentRefs).filter((name) => !visited.has(name));
    }
    return Object.fromEntries(Object.keys(output).sort(compareCodeUnits).map((name) => [name, output[name]]));
  }

  servers(): OperationCatalog["servers"] {
    const servers = Array.isArray(this.doc.servers) ? this.doc.servers : [];
    return servers.flatMap((server, index) =>
      isRecord(server) && typeof server.url === "string"
        ? [{
            url: this.url(server.url, `/servers/${index}/url`) as string,
            description: this.text(server.description, `/servers/${index}/description`),
          }]
        : []
    );
  }

  specOperations(): SpecOperation[] {
    const paths = isRecord(this.doc.paths) ? this.doc.paths : {};
    const operations: SpecOperation[] = [];
    for (const path of Object.keys(paths).sort(compareCodeUnits)) {
      const resolved = this.deref(paths[path], `/paths/${escapePointer(path)}`);
      if (!resolved) continue;
      for (const method of METHODS) {
        const operation = resolved.value[method];
        if (!isRecord(operation)) continue;
        operations.push({
          method,
          path,
          pointer: `/paths/${escapePointer(path)}/${method}`,
          pathItem: resolved.value,
          operation,
          operationId: typeof operation.operationId === "string" ? operation.operationId : null,
        });
      }
    }
    return operations;
  }

  build(): Omit<OperationCatalog, "source"> & { provenance: OperationCatalog["source"]["provenance"] } {
    this.checkRefs(this.doc, "");
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
        source: this.url(provenance.source, "/provenance/source", "manifest"),
        revision: this.text(provenance.revision, "/provenance/revision", "manifest"),
        exporter: this.text(provenance.exporter, "/provenance/exporter", "manifest"),
      },
      serialization: { mediaTypes: sortStrings(this.mediaTypes) },
      servers: this.servers(),
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
