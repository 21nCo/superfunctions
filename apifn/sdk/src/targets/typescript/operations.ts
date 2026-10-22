// Reads catalog operations into what the TypeScript client needs, and
// explains what it cannot express.

import type { CatalogContent, CatalogOperation, CatalogSecurityScheme, OperationCatalog } from "@apifn/contracts";

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

export interface OperationShape {
  reasons: string[];
  body: { mediaType: string; kind: BodyKind; required: boolean; schema: unknown } | null;
  /** Union of documented 2xx responses; null when the operation documents none, so any 2xx body is returned. */
  success: ResponseShape | null;
  /** Error statuses, `4XX`-style ranges and `default`, in catalog order. */
  errors: Array<{ status: string; shape: ResponseShape }>;
  accept: string[];
  security: SecurityTerm[][];
  unsupportedSchemes: string[];
}

const READ_METHODS = new Set(["get", "head", "options", "trace"]);

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

export function analyzeOperation(operation: CatalogOperation, catalog: OperationCatalog): OperationShape {
  const reasons: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in === "cookie") reasons.push(`cookie parameter "${parameter.name}" cannot be sent: browsers forbid setting the Cookie header from fetch.`);
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
  for (const response of operation.responses) {
    for (const content of response.contents) if (mediaKind(content.mediaType) !== null) accept.add(content.mediaType);
    const { shape, unsupported } = responseShape(response.contents);
    // `default` documents every status not listed; the client reads it for non-2xx responses only.
    if (response.kind !== "success") {
      errors.push({ status: response.status, shape });
      continue;
    }
    if (shape.kinds.length === 0) {
      reasons.push(`success response ${response.status} media types ${unsupported.join(", ")} are not supported.`);
      continue;
    }
    success ??= { kinds: [], contents: [] };
    merge(success, shape);
  }

  // A HEAD response never has a body, whatever its documented content.
  if (operation.method === "head" && success) success = { kinds: ["none"], contents: [{ kind: "none", schema: null }] };

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

  return { reasons, body, success, errors, accept: [...accept].sort(), security, unsupportedSchemes: [...unsupportedSchemes].sort() };
}
