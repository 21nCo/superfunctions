// Python target options: validation and defaults.

import { containsCredentialValue, PACKAGE_NAME_PATTERN, type OperationCatalog } from "@apifn/contracts";
import type { SdkDiagnostic } from "../../types.js";
import { PY_MODULE_NAME, PY_TYPE_NAME, pyPascalCase, PYTHON_KEYWORDS } from "./naming.js";
import { RUNTIME_DEPENDENCY_MODULES, STDLIB_MODULES } from "./reserved-modules.js";
import { canonicalLicenseExpression } from "./spdx.js";

export interface PythonOptions {
  /** Distribution name (normalized PEP 503 form) and normalized PEP 440 version, so installed metadata equals the manifest. */
  package: { name: string; version: string; description: string | null; license: string | null };
  /** Import package name; defaults to the distribution name with `-` replaced by `_`. */
  module: string;
  /** Exported client class name. */
  clientName: string;
  /** Default base URL; null requires every consumer to pass `base_url`. Spec `servers` are never used. */
  baseUrl: string | null;
  timeoutMs: number;
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  /** Component schema name → exported type name, to resolve collisions. */
  typeNames: Record<string, string>;
}

const FIELDS: Record<string, string[]> = {
  "": ["package", "module", "clientName", "baseUrl", "timeoutMs", "retry", "typeNames"],
  "/package": ["name", "version", "description", "license"],
  "/retry": ["maxAttempts", "baseDelayMs", "maxDelayMs"],
};
const MAX_TIMER_MS = 2_147_483_647;
/** A normalized PEP 503 project name. */
const DISTRIBUTION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A normalized PEP 440 public version: release, optional pre-release, post-release and development release. */
const PEP440_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*(?:(?:a|b|rc)(?:0|[1-9]\d*))?(?:\.post(?:0|[1-9]\d*))?(?:\.dev(?:0|[1-9]\d*))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolvePythonOptions(input: unknown, catalog: OperationCatalog): { options: PythonOptions | null; diagnostics: SdkDiagnostic[] } {
  const diagnostics: SdkDiagnostic[] = [];
  const fail = (pointer: string, message: string) => diagnostics.push({ code: "SDK_INVALID_CONFIG", severity: "error", message, pointer: `/options${pointer}` });
  const object = (value: unknown, pointer: string): Record<string, unknown> => {
    if (value === undefined && pointer !== "") return {};
    if (!isRecord(value)) {
      fail(pointer, "Expected an object.");
      return {};
    }
    for (const key of Object.keys(value)) {
      if (pointer === "/retry" && key === "idempotentOperations") {
        // Only the catalog can declare that a server makes a write safe to repeat; catalog v1 cannot yet.
        fail("/retry/idempotentOperations", "Write retries come only from catalog idempotency declarations, which catalog v1 does not have; the SDK config cannot make a write retryable.");
      } else if (!FIELDS[pointer]?.includes(key)) fail(`${pointer}/${key}`, `Unknown option "${key}".`);
    }
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
    if (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) && !containsCredentialValue(value)) return value;
    fail(pointer, "Expected a single-line string of at most 512 characters without credentials.");
    return null;
  };

  const root = object(input, "");
  const pkg = object(root.package, "/package");
  if (root.package === undefined) fail("/package", "package { name, version } is required.");
  const name = pkg.name;
  const nameValid = typeof name === "string" && name.length <= 214 && DISTRIBUTION_NAME.test(name) && PACKAGE_NAME_PATTERN.test(name);
  if (!nameValid) fail("/package/name", "Expected a normalized Python distribution name such as example-projects-sdk (lowercase letters and digits joined by single hyphens).");
  const version = pkg.version;
  if (typeof version !== "string" || version.length > 64 || !PEP440_VERSION.test(version)) {
    fail("/package/version", "Expected a normalized PEP 440 version such as 1.0.0, 1.0.0rc1 or 1.0.0.post1.");
  }
  const license = text(pkg.license, "/package/license");
  if (license !== null) {
    // In normalized form, which the build backend writes unchanged, so the installed License-Expression equals the option.
    const canonical = canonicalLicenseExpression(license);
    if (canonical !== license) {
      fail("/package/license", canonical === null ? "Expected an SPDX license expression such as MIT or Apache-2.0 OR MIT, of SPDX license and exception identifiers or LicenseRef- names." : `Expected the normalized SPDX license expression "${canonical}".`);
    }
  }

  const module = root.module ?? (nameValid ? (name as string).replace(/-/g, "_") : "");
  if (typeof module !== "string" || module.length > 100 || !PY_MODULE_NAME.test(module) || PYTHON_KEYWORDS.has(module)) {
    if (nameValid || root.module !== undefined) fail("/module", "Expected a lowercase Python import name such as example_projects_sdk that is not a keyword.");
  } else if (STDLIB_MODULES.has(module) || RUNTIME_DEPENDENCY_MODULES.has(module)) {
    // The package would be imported in place of that module, by its own runtime and by everything else installed.
    const shadowed = STDLIB_MODULES.has(module) ? "a standard-library module" : "a runtime dependency of the generated package";
    const pointer = root.module !== undefined ? "/module" : "/package/name";
    fail(pointer, `The import name "${module}" would shadow ${shadowed}; ${root.module !== undefined ? "choose another module" : "set module to another import name"}.`);
  }

  const clientName = root.clientName ?? `${pyPascalCase(catalog.api.id)}Client`;
  if (typeof clientName !== "string" || !PY_TYPE_NAME.test(clientName) || clientName.length > 128 || PYTHON_KEYWORDS.has(clientName)) {
    fail("/clientName", "Expected a PascalCase identifier such as ProjectsClient.");
  }

  let baseUrl: string | null = null;
  if (root.baseUrl !== undefined) {
    baseUrl = typeof root.baseUrl === "string" ? root.baseUrl : null;
    let url: URL | null = null;
    try {
      url = baseUrl === null ? null : new URL(baseUrl);
    } catch {
      url = null;
    }
    // The runtime reads the URL as written, so it must already be in the form a URL parser would leave it.
    const plain = baseUrl !== null && /^[\x21-\x7e]+$/.test(baseUrl) && !baseUrl.includes("\\") && !baseUrl.split("/").slice(3).some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
    if (!url || !plain || (url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || /[?#]/.test(baseUrl ?? "")) {
      fail("/baseUrl", "Expected an absolute http or https URL of printable ASCII, without user info, query, fragment or dot segments.");
    }
  }

  const retry = object(root.retry, "/retry");

  // Collected as entries: a "__proto__" schema name must stay an own property.
  const typeNames: Array<[string, string]> = [];
  if (root.typeNames !== undefined) {
    if (!isRecord(root.typeNames)) fail("/typeNames", "Expected an object mapping component schema names to type names.");
    else {
      for (const [schema, typeName] of Object.entries(root.typeNames)) {
        const pointer = `/typeNames/${schema.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (!Object.prototype.hasOwnProperty.call(catalog.schemas, schema)) fail(pointer, "Not a component schema in the catalog.");
        else if (typeof typeName !== "string" || !PY_TYPE_NAME.test(typeName) || typeName.length > 128 || PYTHON_KEYWORDS.has(typeName)) fail(pointer, "Expected a PascalCase identifier.");
        else typeNames.push([schema, typeName]);
      }
    }
  }

  const options: PythonOptions = {
    package: { name: name as string, version: version as string, description: text(pkg.description, "/package/description"), license },
    module: module as string,
    clientName: clientName as string,
    baseUrl,
    timeoutMs: integer(root.timeoutMs, "/timeoutMs", 1, MAX_TIMER_MS, 30_000),
    retry: {
      maxAttempts: integer(retry.maxAttempts, "/retry/maxAttempts", 1, 10, 3),
      baseDelayMs: integer(retry.baseDelayMs, "/retry/baseDelayMs", 0, MAX_TIMER_MS, 200),
      maxDelayMs: integer(retry.maxDelayMs, "/retry/maxDelayMs", 0, MAX_TIMER_MS, 5_000),
    },
    typeNames: Object.fromEntries(typeNames),
  };
  return diagnostics.length > 0 ? { options: null, diagnostics } : { options, diagnostics };
}
