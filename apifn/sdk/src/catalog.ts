// Validates catalogs against the published operation-catalog.v1 JSON Schema
// before any target reads them, so targets can rely on its shape.

import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, type OperationCatalog } from "@apifn/contracts";
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
  return { catalog, diagnostics: [] };
}
