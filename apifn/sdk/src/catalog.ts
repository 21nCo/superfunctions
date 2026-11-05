// Validates catalogs against the published operation-catalog.v1 JSON Schema
// before any target reads them, so targets can rely on its shape.

import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, isCredentialKey, isFetchControlledHeader, isIgnoredHeaderParameter, type CatalogOperation, type OperationCatalog } from "@apifn/contracts";
import catalogSchema from "@apifn/contracts/schemas/operation-catalog.v1.schema.json";
import type { SdkDiagnostic } from "./types.js";

let validator: ReturnType<Ajv2020["compile"]> | undefined;

function compile() {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(catalogSchema);
  }
  return validator;
}

/** Reads the catalog as plain JSON data and checks it; returns the copy that was checked. */
export function validateCatalog(input: unknown): { catalog: OperationCatalog | null; diagnostics: SdkDiagnostic[] } {
  const fail = (message: string, pointer = ""): { catalog: null; diagnostics: SdkDiagnostic[] } => ({
    catalog: null,
    diagnostics: [{ code: "SDK_INVALID_CATALOG", severity: "error", message, pointer }],
  });
  let copy: unknown;
  try {
    // Canonical JSON rejects data with no single JSON form; parsing it back gives a plain snapshot getters cannot change.
    copy = JSON.parse(canonicalJson(input));
  } catch (error) {
    return fail(`Catalog must be plain JSON data: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = compile();
  if (!validate(copy)) {
    const diagnostics: SdkDiagnostic[] = (validate.errors ?? []).slice(0, 20).map((error) => ({
      code: "SDK_INVALID_CATALOG",
      severity: "error",
      message: `Catalog does not match operation-catalog.v1: ${error.instancePath || "/"} ${error.message ?? "is invalid"}.`,
      pointer: error.instancePath,
    }));
    return { catalog: null, diagnostics };
  }
  const catalog = copy as OperationCatalog;
  const seen = new Set<string>();
  for (const [index, operation] of catalog.operations.entries()) {
    if (seen.has(operation.id)) return fail(`Operation ID "${operation.id}" is repeated; catalog operation IDs are unique.`, `/operations/${index}/id`);
    seen.add(operation.id);
  }
  const apiKeyHeaders = new Set(
    Object.values(catalog.securitySchemes).flatMap((scheme) => (scheme.type === "apiKey" && scheme.in === "header" ? [asciiLower(scheme.name)] : []))
  );
  for (const [index, operation] of catalog.operations.entries()) {
    const problem = idempotencyProblem(operation, apiKeyHeaders);
    if (problem) return fail(problem.message, `/operations/${index}/idempotency${problem.pointer}`);
  }
  return { catalog, diagnostics: [] };
}

/** Methods an idempotency declaration may cover: the writes. The others are safe methods (RFC 9110 section 9.2.1). */
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

/** HTTP field names ignore ASCII case only, so a non-token spelling (a Kelvin sign for "K") never matches. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The checks the catalog builder makes on an idempotency declaration, repeated for a catalog read directly:
 * the schema cannot relate the declaration to the operation's method, parameters or security schemes. Only a
 * write takes one, and a key must be a non-credential header parameter of the operation; a credential header
 * is the same on every call, so treating it as the key would make every credentialed call retryable. Nor may
 * the key be `Accept`, `Content-Type` or `Authorization`: the builder never publishes them, and the runtimes set
 * them on every call, so such a key would make every call of the write retryable without a caller key. Nor may it
 * be a header Fetch forbids or overwrites (`Sec-*`, `Proxy-*`, `Cookie`, `Host`, ...): the server would not receive
 * the caller's value, so distinct calls could reach it under one key, or retries under none.
 */
function idempotencyProblem(operation: CatalogOperation, apiKeyHeaders: Set<string>): { message: string; pointer: string } | null {
  const declaration = operation.idempotency;
  if (declaration === undefined) return null;
  if (!WRITE_METHODS.has(operation.method)) {
    return { pointer: "", message: `Operation "${operation.id}" is a ${operation.method.toUpperCase()}, which HTTP defines as safe; idempotency is declared only for POST, PUT, PATCH and DELETE.` };
  }
  if (declaration.key === null) return null;
  const wanted = asciiLower(declaration.key.name);
  const parameter = operation.parameters.find((candidate) => candidate.in === "header" && asciiLower(candidate.name) === wanted);
  if (isIgnoredHeaderParameter(declaration.key.name)) {
    return { pointer: "/key/name", message: `Operation "${operation.id}" declares idempotency key header "${declaration.key.name}", which OpenAPI ignores as a parameter and the client sets itself; the key must be a per-call header parameter.` };
  }
  if (isFetchControlledHeader(declaration.key.name)) {
    return { pointer: "/key/name", message: `Operation "${operation.id}" declares idempotency key header "${declaration.key.name}", which Fetch forbids or overwrites, so a client cannot send it as a per-call key.` };
  }
  if (!parameter) {
    return { pointer: "/key/name", message: `Operation "${operation.id}" declares idempotency key header "${declaration.key.name}", which is not one of its header parameters.` };
  }
  if (isCredentialKey(parameter.name) || isCredentialKey(declaration.key.name) || apiKeyHeaders.has(wanted)) {
    return { pointer: "/key/name", message: `Operation "${operation.id}" declares idempotency key header "${declaration.key.name}", which is a credential field; the key must be a per-call header parameter.` };
  }
  return null;
}
