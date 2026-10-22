// TypeScript target options: validation and defaults.

import { containsCredentialValue, PACKAGE_NAME_PATTERN, SEMVER_PATTERN, type OperationCatalog } from "@apifn/contracts";
import type { SdkDiagnostic } from "../../types.js";
import { pascalCase, TYPE_NAME } from "./naming.js";

export interface TypeScriptOptions {
  package: { name: string; version: string; description: string | null; license: string | null };
  /** Exported client class name. */
  clientName: string;
  /** Default base URL; null requires every consumer to pass `baseUrl`. Spec `servers` are never used. */
  baseUrl: string | null;
  timeoutMs: number;
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    /**
     * Writes whose server provides idempotency semantics, by stable operation ID. Catalog v1 carries no
     * idempotency field (method, schema and an `Idempotency-Key` parameter grant none), so this reviewed
     * declaration is the only way a write becomes retryable.
     */
    idempotentOperations: string[];
  };
  /** Component schema name → exported type name, to resolve collisions. */
  typeNames: Record<string, string>;
}

const FIELDS: Record<string, string[]> = {
  "": ["package", "clientName", "baseUrl", "timeoutMs", "retry", "typeNames"],
  "/package": ["name", "version", "description", "license"],
  "/retry": ["maxAttempts", "baseDelayMs", "maxDelayMs", "idempotentOperations"],
};
const MAX_TIMER_MS = 2_147_483_647;
const READ_METHODS = new Set(["get", "head", "options", "trace"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function resolveTypeScriptOptions(input: unknown, catalog: OperationCatalog): { options: TypeScriptOptions | null; diagnostics: SdkDiagnostic[] } {
  const diagnostics: SdkDiagnostic[] = [];
  const fail = (pointer: string, message: string) => diagnostics.push({ code: "SDK_INVALID_CONFIG", severity: "error", message, pointer: `/options${pointer}` });
  const object = (value: unknown, pointer: string): Record<string, unknown> => {
    if (value === undefined && pointer !== "") return {};
    if (!isRecord(value)) {
      fail(pointer, "Expected an object.");
      return {};
    }
    for (const key of Object.keys(value)) if (!FIELDS[pointer]?.includes(key)) fail(`${pointer}/${key}`, `Unknown option "${key}".`);
    return value;
  };
  const integer = (value: unknown, pointer: string, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
    fail(pointer, `Expected an integer from ${min} to ${max}.`);
    return fallback;
  };
  const text = (value: unknown, pointer: string): string | null => {
    if (value === undefined) return null;
    if (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) && !containsCredentialValue(value)) return value;
    fail(pointer, "Expected a single-line string of at most 512 characters without credentials.");
    return null;
  };

  const root = object(input, "");
  const pkg = object(root.package, "/package");
  if (root.package === undefined) fail("/package", "package { name, version } is required.");
  const name = pkg.name;
  if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME_PATTERN.test(name) || name !== name.toLowerCase()) {
    fail("/package/name", "Expected a lowercase npm package name such as @example/projects-sdk.");
  }
  const version = pkg.version;
  if (typeof version !== "string" || version.length > 64 || !SEMVER_PATTERN.test(version)) fail("/package/version", "Expected a SemVer version such as 1.0.0.");

  const clientName = root.clientName ?? `${pascalCase(catalog.api.id)}Client`;
  if (typeof clientName !== "string" || !TYPE_NAME.test(clientName) || clientName.length > 128) fail("/clientName", "Expected a PascalCase identifier such as ProjectsClient.");

  let baseUrl: string | null = null;
  if (root.baseUrl !== undefined) {
    baseUrl = typeof root.baseUrl === "string" ? root.baseUrl : null;
    let url: URL | null = null;
    try {
      url = baseUrl === null ? null : new URL(baseUrl);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || /[?#]/.test(baseUrl ?? "")) {
      fail("/baseUrl", "Expected an absolute http or https URL without user info, query or fragment.");
    }
  }

  const retry = object(root.retry, "/retry");
  const idempotentOperations: string[] = [];
  if (retry.idempotentOperations !== undefined) {
    if (!Array.isArray(retry.idempotentOperations)) fail("/retry/idempotentOperations", "Expected an array of operation IDs.");
    else {
      retry.idempotentOperations.forEach((id: unknown, index: number) => {
        const pointer = `/retry/idempotentOperations/${index}`;
        const operation = catalog.operations.find((candidate) => candidate.id === id);
        if (typeof id !== "string" || !operation) fail(pointer, "Expected the ID of an operation in the catalog.");
        else if (READ_METHODS.has(operation.method)) fail(pointer, `${id} is a ${operation.method.toUpperCase()} operation; reads are retried without a declaration.`);
        else if (idempotentOperations.includes(id)) fail(pointer, `${id} is listed twice.`);
        else idempotentOperations.push(id);
      });
    }
  }

  // Collected as entries: a "__proto__" schema name must stay an own property.
  const typeNames: Array<[string, string]> = [];
  if (root.typeNames !== undefined) {
    if (!isRecord(root.typeNames)) fail("/typeNames", "Expected an object mapping component schema names to type names.");
    else {
      for (const [schema, typeName] of Object.entries(root.typeNames)) {
        const pointer = `/typeNames/${schema.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (!Object.prototype.hasOwnProperty.call(catalog.schemas, schema)) fail(pointer, "Not a component schema in the catalog.");
        else if (typeof typeName !== "string" || !TYPE_NAME.test(typeName) || typeName.length > 128) fail(pointer, "Expected a PascalCase identifier.");
        else typeNames.push([schema, typeName]);
      }
    }
  }

  const options: TypeScriptOptions = {
    package: { name: name as string, version: version as string, description: text(pkg.description, "/package/description"), license: text(pkg.license, "/package/license") },
    clientName: clientName as string,
    baseUrl,
    timeoutMs: integer(root.timeoutMs, "/timeoutMs", 1, MAX_TIMER_MS, 30_000),
    retry: {
      maxAttempts: integer(retry.maxAttempts, "/retry/maxAttempts", 1, 10, 3),
      baseDelayMs: integer(retry.baseDelayMs, "/retry/baseDelayMs", 0, MAX_TIMER_MS, 200),
      maxDelayMs: integer(retry.maxDelayMs, "/retry/maxDelayMs", 0, MAX_TIMER_MS, 5_000),
      idempotentOperations: idempotentOperations.sort(compare),
    },
    typeNames: Object.fromEntries(typeNames),
  };
  return diagnostics.length > 0 ? { options: null, diagnostics } : { options, diagnostics };
}
