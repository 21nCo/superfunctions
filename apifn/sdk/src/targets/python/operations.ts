// Reads catalog operations into what the Python client needs, and explains what it cannot express.
// Parameter serialization support and media kinds are shared with the TypeScript target, so both
// clients send the same requests for the operations they both include.

import type { CatalogContent, CatalogOperation, CatalogSecurityScheme, OperationCatalog } from "@apifn/contracts";
import { compareCodeUnits } from "../../paths.js";
import { type BodyKind, mediaKind, parameterSupport, type ParameterNarrowing, type ResponseShape, type SecurityTerm } from "../typescript/operations.js";

export interface PythonOperationShape {
  reasons: string[];
  /** Narrowing of each parameter, in catalog order (see `parameterSupport`). */
  parameters: ParameterNarrowing[];
  body: { mediaType: string; kind: BodyKind; required: boolean; schema: unknown } | null;
  /** Union of documented 2xx responses (exact or `2XX`); null when the operation documents none, so any 2xx body is returned. */
  success: ResponseShape | null;
  /** Every other documented status (1xx, 3xx, 4xx, 5xx), range and `default`, in catalog order: the client raises them. */
  errors: Array<{ status: string; shape: ResponseShape }>;
  accept: string[];
  security: SecurityTerm[][];
  unsupportedSchemes: string[];
}

/** Methods whose requests have no content: HTTP gives a body on GET or HEAD no meaning, and TRACE must not send one (RFC 9110). */
const NO_CONTENT_METHODS = new Set(["get", "head", "trace"]);
/** Statuses whose responses never have content. */
const BODYLESS_STATUSES = new Set(["204", "205", "304"]);

/** How the client injects a scheme's credential, or null when it cannot. */
function securityTerm(name: string, scheme: CatalogSecurityScheme | undefined): SecurityTerm | null {
  if (!scheme) return null;
  switch (scheme.type) {
    case "apiKey":
      // The client keeps no cookie state; a cookie key is unsupported, as in the TypeScript target.
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

export function analyzePythonOperation(operation: CatalogOperation, catalog: OperationCatalog): PythonOperationShape {
  const reasons: string[] = [];
  if (operation.requestBody && NO_CONTENT_METHODS.has(operation.method)) {
    reasons.push(`a ${operation.method.toUpperCase()} request has no content in HTTP, so its request body cannot be sent.`);
  }
  const parameters: ParameterNarrowing[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in === "cookie") {
      reasons.push(`cookie parameter "${parameter.name}" is not supported: the Python client keeps no cookie state.`);
      parameters.push(null);
      continue;
    }
    const support = parameterSupport(parameter, catalog.schemas);
    reasons.push(...support.reasons);
    parameters.push(support.narrowing);
  }

  let body: PythonOperationShape["body"] = null;
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
  const errors: PythonOperationShape["errors"] = [];
  const accept = new Set<string>();
  const head = operation.method === "head";
  for (const response of operation.responses) {
    // As in the TypeScript target: Accept lists the documented media types the client decodes, and every
    // documented media type for HEAD, whose responses the client never decodes.
    for (const content of response.contents) if (head || mediaKind(content.mediaType) !== null) accept.add(content.mediaType);
    const { shape, unsupported } = head || BODYLESS_STATUSES.has(response.status) ? responseShape([]) : responseShape(response.contents);
    if (!/^2(?:\d\d|XX)$/.test(response.status)) {
      errors.push({ status: response.status, shape });
      continue;
    }
    if (shape.kinds.length === 0) {
      reasons.push(`success response ${response.status} media types ${unsupported.join(", ")} are not supported.`);
      continue;
    }
    success ??= { kinds: [], contents: [] };
    for (const kind of shape.kinds) if (!success.kinds.includes(kind)) success.kinds.push(kind);
    success.contents.push(...shape.contents);
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
