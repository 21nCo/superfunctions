// Reads catalog operations into what the TypeScript client needs, and
// explains what it cannot express.

import type { CatalogContent, CatalogOperation, CatalogParameter, CatalogSecurityScheme, OperationCatalog } from "@apifn/contracts";
import { compareCodeUnits } from "../../paths.js";
import { ARRAY, containerMembers, INCOMPLETE, NULL, OBJECT, SCALAR, valueKinds } from "./schema.js";

export type BodyKind = "json" | "text" | "binary";
export type ResponseKind = BodyKind | "none";

export type SecurityTerm =
  | { scheme: string; type: "bearer" }
  | { scheme: string; type: "basic" }
  | { scheme: string; type: "apiKey"; in: "header" | "query"; name: string };

export interface ResponseShape {
  kinds: ResponseKind[];
  /** Body schema per kind; JSON kinds keep their schemas. */
  contents: Array<{ kind: ResponseKind; schema: unknown }>;
}

/**
 * How a parameter's emitted type is narrowed to the values the client serializes (see `parameterSupport`):
 * `value` (runtime `ParamValue`), `deepObject` (runtime `DeepObjectValue`), or null to keep the schema type.
 */
export type ParameterNarrowing = "value" | "deepObject" | null;

export interface OperationShape {
  reasons: string[];
  /** Narrowing of each parameter, in catalog order. */
  parameters: ParameterNarrowing[];
  body: { mediaType: string; kind: BodyKind; required: boolean; schema: unknown } | null;
  /** Union of documented 2xx responses (exact or `2XX`); null when the operation documents none, so any 2xx body is returned. */
  success: ResponseShape | null;
  /** Every other documented status (1xx, 3xx, 4xx, 5xx), range and `default`, in catalog order: the client throws them. */
  errors: Array<{ status: string; shape: ResponseShape }>;
  accept: string[];
  security: SecurityTerm[][];
  unsupportedSchemes: string[];
}

const READ_METHODS = new Set(["get", "head", "options", "trace"]);
/** Methods fetch refuses to send (Fetch standard "forbidden method"). */
const FORBIDDEN_METHODS = new Set(["connect", "trace", "track"]);

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

export function mediaKind(mediaType: string): BodyKind | null {
  const type = mediaType.toLowerCase();
  if (type === "application/json" || /^application\/[^/;]+\+json$/.test(type)) return "json";
  if (type === "text/plain") return "text";
  if (type === "application/octet-stream") return "binary";
  return null;
}

/** How the client injects a scheme's credential, or null when it cannot. */
export function securityTerm(name: string, scheme: CatalogSecurityScheme | undefined): SecurityTerm | null {
  if (!scheme) return null;
  switch (scheme.type) {
    case "apiKey":
      // Browsers forbid setting the Cookie header from fetch.
      return scheme.in === "cookie" ? null : { scheme: name, type: "apiKey", in: scheme.in, name: scheme.name };
    case "http": {
      const kind = scheme.scheme.toLowerCase();
      return kind === "bearer" ? { scheme: name, type: "bearer" } : kind === "basic" ? { scheme: name, type: "basic" } : null;
    }
    case "oauth2":
    case "openIdConnect":
      // The consumer supplies an access token; flows run outside the client.
      return { scheme: name, type: "bearer" };
    default:
      return null;
  }
}

function responseShape(contents: CatalogContent[]): { shape: ResponseShape; unsupported: string[] } {
  if (contents.length === 0) return { shape: { kinds: ["none"], contents: [{ kind: "none", schema: null }] }, unsupported: [] };
  const shape: ResponseShape = { kinds: [], contents: [] };
  const unsupported: string[] = [];
  for (const content of contents) {
    const kind = mediaKind(content.mediaType);
    if (kind === null) {
      unsupported.push(content.mediaType);
      continue;
    }
    if (!shape.kinds.includes(kind)) shape.kinds.push(kind);
    shape.contents.push({ kind, schema: content.schema });
  }
  return { shape, unsupported };
}

function merge(target: ResponseShape, source: ResponseShape): void {
  for (const kind of source.kinds) if (!target.kinds.includes(kind)) target.kinds.push(kind);
  target.contents.push(...source.contents);
}

/**
 * Whether an API key credential of some alternative is sent under the parameter's name and location
 * (header names ignore case). The credential replaces such a parameter, so the parameter is optional
 * input even when required: the client checks it only when no applied credential supplies it.
 */
export function suppliedByCredential(parameter: { name: string; in: string }, security: SecurityTerm[][]): boolean {
  return security.some((terms) =>
    terms.some(
      (term) =>
        term.type === "apiKey" &&
        term.in === parameter.in &&
        (term.in === "header" ? term.name.toLowerCase() === parameter.name.toLowerCase() : term.name === parameter.name)
    )
  );
}

const CONTAINER = ARRAY | OBJECT;

/**
 * Whether the client can serialize the values a parameter's type admits. It sends strings, finite numbers
 * and booleans, arrays of them and objects whose members are them or null (null members are skipped); a
 * deepObject parameter must be such an object. A position whose type admits none of these makes the
 * parameter unsupported, with a reason. A type that admits them and other values too, such as an
 * `unknown` member, is narrowed to the serializable part instead. A schema nested too deeply to analyze is
 * unsupported too, rather than narrowed on a guess.
 */
export function parameterSupport(parameter: CatalogParameter, schemas: Readonly<Record<string, unknown>>): { reasons: string[]; narrowing: ParameterNarrowing } {
  const label = `${parameter.in} parameter "${parameter.name}"`;
  const reasons = new Set<string>();
  const deepObject = parameter.style === "deepObject";
  const top = valueKinds(parameter.schema, schemas);
  const found = containerMembers(parameter.schema, schemas);
  let narrow = found.opaque;
  if ((top & INCOMPLETE) !== 0 || found.incomplete) reasons.add(`${label}: its schema nests subschemas too deeply for the generator to analyze.`);
  if (deepObject) {
    if ((top & OBJECT) === 0) reasons.add(`${label} uses deepObject serialization, but its schema admits no object.`);
    else if ((top & (SCALAR | ARRAY)) !== 0) narrow = true;
  } else {
    for (const kinds of found.items) {
      if ((kinds & SCALAR) === 0 && (kinds & (NULL | CONTAINER)) !== 0) {
        reasons.add(`${label}: its array items admit no string, number or boolean, the only items the client can serialize.`);
      } else if ((kinds & (NULL | CONTAINER)) !== 0) narrow = true;
    }
  }
  for (const { name, kinds } of found.members) {
    if ((kinds & SCALAR) === 0 && (kinds & CONTAINER) !== 0) {
      reasons.add(`${label}: ${name === null ? "its additional members admit" : `its member "${name}" admits`} only nested objects or arrays, which the client cannot serialize.`);
    } else if ((kinds & CONTAINER) !== 0) narrow = true;
  }
  return { reasons: [...reasons], narrowing: reasons.size > 0 || !narrow ? null : deepObject ? "deepObject" : "value" };
}

export function analyzeOperation(operation: CatalogOperation, catalog: OperationCatalog): OperationShape {
  const reasons: string[] = [];
  if (FORBIDDEN_METHODS.has(operation.method)) reasons.push(`fetch cannot send ${operation.method.toUpperCase()} requests.`);
  if (operation.requestBody && (operation.method === "get" || operation.method === "head")) {
    reasons.push(`fetch cannot send a request body with ${operation.method.toUpperCase()}.`);
  }
  const parameters: ParameterNarrowing[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in === "cookie") {
      reasons.push(`cookie parameter "${parameter.name}" cannot be sent: browsers forbid setting the Cookie header from fetch.`);
      parameters.push(null);
      continue;
    }
    const support = parameterSupport(parameter, catalog.schemas);
    reasons.push(...support.reasons);
    parameters.push(support.narrowing);
  }

  let body: OperationShape["body"] = null;
  if (operation.requestBody) {
    const candidates = operation.requestBody.contents
      .map((content) => ({ content, kind: mediaKind(content.mediaType) }))
      .filter((entry): entry is { content: CatalogContent; kind: BodyKind } => entry.kind !== null);
    const preferred = (["json", "text", "binary"] as const).map((kind) => candidates.find((entry) => entry.kind === kind)).find((entry) => entry !== undefined);
    if (preferred) {
      body = { mediaType: preferred.content.mediaType, kind: preferred.kind, required: operation.requestBody.required, schema: preferred.content.schema };
    } else if (operation.requestBody.contents.length > 0) {
      const types = operation.requestBody.contents.map((content) => content.mediaType).join(", ");
      reasons.push(`request body media types ${types} are not supported (supported: JSON, text/plain, application/octet-stream).`);
    } else if (operation.requestBody.required) {
      reasons.push("the required request body declares no media type.");
    }
  }

  let success: ResponseShape | null = null;
  const errors: OperationShape["errors"] = [];
  const accept = new Set<string>();
  // A HEAD response never has a body, whatever its documented content, so every documented status
  // (success, error, range or `default`) is matched, and typed, as no content, and its media types are
  // never checked for support.
  const bodyless = operation.method === "head";
  for (const response of operation.responses) {
    for (const content of response.contents) if (mediaKind(content.mediaType) !== null) accept.add(content.mediaType);
    const { shape, unsupported } = bodyless ? responseShape([]) : responseShape(response.contents);
    // Only 2xx responses resolve a call; every other documented status (redirects are not followed) and
    // `default`, which documents every status not listed, become typed errors.
    if (!/^2(?:\d\d|XX)$/.test(response.status)) {
      errors.push({ status: response.status, shape });
      continue;
    }
    if (shape.kinds.length === 0) {
      reasons.push(`success response ${response.status} media types ${unsupported.join(", ")} are not supported.`);
      continue;
    }
    if (bodyless) {
      success = shape;
      continue;
    }
    success ??= { kinds: [], contents: [] };
    merge(success, shape);
  }

  const unsupportedSchemes = new Set<string>();
  const security: SecurityTerm[][] = [];
  for (const alternative of operation.security.alternatives) {
    const terms = alternative.map((term) => {
      const mapped = securityTerm(term.scheme, catalog.securitySchemes[term.scheme]);
      if (!mapped) unsupportedSchemes.add(term.scheme);
      return mapped;
    });
    if (terms.every((term): term is SecurityTerm => term !== null)) security.push(terms);
  }
  if (operation.security.alternatives.length > 0 && security.length === 0) {
    reasons.push(`no security alternative uses only supported schemes (unsupported: ${[...unsupportedSchemes].join(", ")}).`);
  }

  return { reasons, parameters, body, success, errors, accept: [...accept].sort(compareCodeUnits), security, unsupportedSchemes: [...unsupportedSchemes].sort(compareCodeUnits) };
}
