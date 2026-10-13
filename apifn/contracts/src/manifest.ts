import { containsCredentialIdentifier, pointerSegment, redactWhole, sanitizeReport } from "./credentials.js";
import type { ApiManifest, Diagnostic } from "./types.js";

export const API_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const OPERATION_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
export const TARGET_PATTERN = /^[a-z][a-z0-9-]*$/;
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
export const POLICY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** Media types the catalog can describe for generated clients. */
export function isSupportedMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    /^application\/[a-z0-9.+-]+\+json$/.test(mediaType) ||
    mediaType === "text/plain" ||
    mediaType === "application/octet-stream" ||
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "multipart/form-data"
  );
}

/**
 * Media type parameters that change the wire bytes: every parameter except
 * `charset=utf-8`, which clients use anyway. The catalog emits bare media
 * types, so a media type with any of these cannot be described.
 */
export function mediaTypeParameters(mediaType: string): string[] {
  return mediaType
    .split(";")
    .slice(1)
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter !== "" && !/^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parameter));
}

export function normalizeMediaType(mediaType: string): string {
  return mediaType.split(";")[0].trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ManifestChecker {
  readonly diagnostics: Diagnostic[] = [];

  fail(pointer: string, message: string, code: Diagnostic["code"] = "INVALID_MANIFEST"): void {
    // Unknown keys and invalid values are quoted back, so every report goes through the shared sanitizer.
    this.diagnostics.push({ code, severity: "error", ...sanitizeReport(pointer, message), source: "manifest" });
  }

  object(value: unknown, pointer: string, allowed: string[], required: string[] = []): value is Record<string, unknown> {
    if (!isRecord(value)) {
      this.fail(pointer, `Expected an object at ${pointer || "/"}.`);
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.fail(`${pointer}/${pointerSegment(key)}`, `Unknown manifest field "${key}"; allowed fields are ${allowed.join(", ")}.`);
      }
    }
    for (const key of required) {
      if (value[key] === undefined) this.fail(`${pointer}/${key}`, `Missing required manifest field "${key}".`);
    }
    return true;
  }

  /**
   * Checks a manifest string. Identifiers are copied verbatim into artifacts,
   * so a credential-like one is an error; `text` strings (provenance and
   * deprecation messages) are redacted by the catalog builder instead.
   */
  string(value: unknown, pointer: string, pattern?: RegExp, max = 256, text = false): void {
    if (value === undefined) return;
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
      this.fail(pointer, `Expected a non-empty string of at most ${max} characters at ${pointer}.`);
    } else if (!text && containsCredentialIdentifier(value)) {
      this.fail(pointer, `Value at ${pointer} holds a credential-like value; manifest identifiers are copied verbatim into artifacts.`);
    } else if (pattern && !pattern.test(value)) {
      this.fail(pointer, `Value "${redactWhole(value)}" at ${pointer} must match ${pattern.source}.`);
    }
  }

  boolean(value: unknown, pointer: string): void {
    if (value !== undefined && typeof value !== "boolean") this.fail(pointer, `Expected a boolean at ${pointer}.`);
  }
}

function checkBinding(check: ManifestChecker, binding: unknown, pointer: string): void {
  const fields = ["id", "operationId", "method", "path", "name", "sdk", "agent", "deprecation", "executionPolicy"];
  if (!check.object(binding, pointer, fields, ["id"])) return;
  const value = binding as Record<string, unknown>;
  check.string(value.id, `${pointer}/id`, OPERATION_ID_PATTERN, 128);
  check.string(value.operationId, `${pointer}/operationId`);
  check.string(value.method, `${pointer}/method`);
  check.string(value.path, `${pointer}/path`, /^\//, 1024);
  check.string(value.name, `${pointer}/name`, NAME_PATTERN, 128);
  check.string(value.executionPolicy, `${pointer}/executionPolicy`, POLICY_REF_PATTERN, 128);

  const byOperationId = value.operationId !== undefined;
  const byRoute = value.method !== undefined || value.path !== undefined;
  if (byOperationId === byRoute || (byRoute && (value.method === undefined || value.path === undefined))) {
    check.fail(pointer, `Operation binding "${String(value.id)}" must set either operationId or both method and path.`);
  }
  if (typeof value.method === "string" && !METHODS.has(value.method.toLowerCase())) {
    check.fail(`${pointer}/method`, `Unknown HTTP method "${redactWhole(value.method)}".`);
  }

  if (value.sdk !== undefined && check.object(value.sdk, `${pointer}/sdk`, ["include", "excludeTargets"])) {
    const sdk = value.sdk as Record<string, unknown>;
    check.boolean(sdk.include, `${pointer}/sdk/include`);
    if (sdk.excludeTargets !== undefined) {
      if (!Array.isArray(sdk.excludeTargets)) {
        check.fail(`${pointer}/sdk/excludeTargets`, "Expected an array of target names.");
      } else {
        sdk.excludeTargets.forEach((target, index) =>
          check.string(target, `${pointer}/sdk/excludeTargets/${index}`, TARGET_PATTERN, 32)
        );
      }
    }
  }
  if (value.agent !== undefined && check.object(value.agent, `${pointer}/agent`, ["expose"])) {
    check.boolean((value.agent as Record<string, unknown>).expose, `${pointer}/agent/expose`);
  }
  if (
    value.deprecation !== undefined &&
    check.object(value.deprecation, `${pointer}/deprecation`, ["replacement", "since", "message"])
  ) {
    const deprecation = value.deprecation as Record<string, unknown>;
    check.string(deprecation.replacement, `${pointer}/deprecation/replacement`, OPERATION_ID_PATTERN, 128);
    check.string(deprecation.since, `${pointer}/deprecation/since`, VERSION_PATTERN, 64);
    check.string(deprecation.message, `${pointer}/deprecation/message`, undefined, 1024, true);
  }
}

/**
 * Validates the companion manifest's shape. Unknown fields are rejected so a
 * misspelled exclusion or exposure flag never silently changes artifacts.
 */
export function validateManifest(input: unknown): { manifest: ApiManifest | null; diagnostics: Diagnostic[] } {
  const check = new ManifestChecker();
  const fields = ["manifestVersion", "api", "serialization", "provenance", "operations"];
  if (check.object(input, "", fields, ["manifestVersion", "api", "operations"])) {
    const manifest = input as Record<string, unknown>;
    if (manifest.manifestVersion !== 1) {
      check.fail("/manifestVersion", `Unsupported manifestVersion ${JSON.stringify(manifest.manifestVersion)}; expected 1.`);
    }
    if (check.object(manifest.api, "/api", ["id", "version"], ["id", "version"])) {
      const api = manifest.api as Record<string, unknown>;
      check.string(api.id, "/api/id", API_ID_PATTERN, 128);
      check.string(api.version, "/api/version", VERSION_PATTERN, 64);
    }
    if (manifest.serialization !== undefined && check.object(manifest.serialization, "/serialization", ["mediaTypes"], ["mediaTypes"])) {
      const mediaTypes = (manifest.serialization as Record<string, unknown>).mediaTypes;
      if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) {
        check.fail("/serialization/mediaTypes", "Expected a non-empty array of media types.");
      } else {
        mediaTypes.forEach((mediaType, index) => {
          const pointer = `/serialization/mediaTypes/${index}`;
          check.string(mediaType, pointer, undefined, 128);
          if (typeof mediaType === "string" && (!isSupportedMediaType(normalizeMediaType(mediaType)) || mediaTypeParameters(mediaType).length > 0)) {
            check.fail(
              pointer,
              `Media type "${mediaType}" is not a supported serialization; use JSON (application/json or +json), text/plain, application/octet-stream, application/x-www-form-urlencoded or multipart/form-data, with no parameter other than charset=utf-8.`,
              "UNSUPPORTED_SERIALIZATION"
            );
          }
        });
      }
    }
    if (manifest.provenance !== undefined && check.object(manifest.provenance, "/provenance", ["source", "revision", "exporter"])) {
      const provenance = manifest.provenance as Record<string, unknown>;
      check.string(provenance.source, "/provenance/source", undefined, 512, true);
      check.string(provenance.revision, "/provenance/revision", undefined, 128, true);
      check.string(provenance.exporter, "/provenance/exporter", undefined, 128, true);
    }
    if (!Array.isArray(manifest.operations)) {
      check.fail("/operations", "Expected an array of operation bindings.");
    } else {
      manifest.operations.forEach((binding, index) => checkBinding(check, binding, `/operations/${index}`));
    }
  }
  const valid = check.diagnostics.length === 0;
  return { manifest: valid ? (input as ApiManifest) : null, diagnostics: check.diagnostics };
}
