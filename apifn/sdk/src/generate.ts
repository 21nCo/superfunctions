// Target-independent SDK generation: validates inputs, selects operations,
// runs the target and assembles the artifact manifest.

import { canonicalDigest, canonicalJson, createReleaseDescriptor, sha256Hex, TARGET_PATTERN, type CatalogOperation } from "@apifn/contracts";
import { validateCatalog } from "./catalog.js";
import { comparePaths, isSafeRelativePath } from "./paths.js";
import {
  SDK_ARTIFACT_MANIFEST_FILE,
  SDK_OUTPUT_LOCK_FILE,
  SDK_ARTIFACT_MANIFEST_VERSION,
  type SdkArtifactManifest,
  type SdkDiagnostic,
  type SdkFile,
  type SdkGenerationResult,
  type SdkGeneratorIdentity,
  type SdkTarget,
} from "./types.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./version.js";

export interface GenerateSdkInput {
  catalog: unknown;
  config: unknown;
  /** Available targets; the config's `target` selects one by ID. */
  targets: readonly SdkTarget<any>[];
}

const CONFIG_FIELDS = new Set(["target", "unsupported", "options"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(diagnostics: SdkDiagnostic[]): SdkGenerationResult {
  return { ok: false, files: [], manifest: null, diagnostics };
}

/**
 * Generates one SDK package. Identical catalog, config, generator and target
 * versions give byte-identical files. Never throws for bad input; any error
 * diagnostic yields `ok: false` and no files.
 */
export function generateSdk(input: GenerateSdkInput): SdkGenerationResult {
  const { catalog, diagnostics: catalogDiagnostics } = validateCatalog(input.catalog);
  if (!catalog) return failed(catalogDiagnostics);

  const configError = (message: string, pointer: string) => failed([{ code: "SDK_INVALID_CONFIG", severity: "error", message, pointer }]);
  let config: unknown;
  try {
    config = JSON.parse(canonicalJson(input.config));
  } catch {
    return configError("SDK config must be plain JSON data.", "");
  }
  if (!isRecord(config)) return configError("SDK config must be an object with target and options.", "");
  for (const key of Object.keys(config)) {
    if (!CONFIG_FIELDS.has(key)) return configError(`Unknown SDK config field "${key}".`, `/${key}`);
  }
  const targetId = config.target;
  const target = input.targets.find((candidate) => candidate.id === targetId);
  if (typeof targetId !== "string" || !target) {
    return configError(`Unknown target; available: ${input.targets.map((candidate) => candidate.id).join(", ")}.`, "/target");
  }
  if (!TARGET_PATTERN.test(target.id)) return configError(`Target ID "${target.id}" does not match ${TARGET_PATTERN.source}.`, "/target");
  const unsupportedPolicy = config.unsupported ?? "fail";
  if (unsupportedPolicy !== "fail" && unsupportedPolicy !== "exclude") return configError('unsupported must be "fail" or "exclude".', "/unsupported");
  const resolved = target.resolveOptions(config.options, catalog);
  if (!resolved.options) return failed(resolved.diagnostics);
  const options = resolved.options;
  const diagnostics: SdkDiagnostic[] = [...resolved.diagnostics];

  // Operation selection: manifest switches first, then target support.
  const included: CatalogOperation[] = [];
  const excluded: SdkArtifactManifest["operations"]["excluded"] = [];
  for (const operation of catalog.operations) {
    if (!operation.sdk.include) {
      excluded.push({ id: operation.id, reason: "sdk-include-false", details: [] });
      continue;
    }
    if (operation.sdk.excludedTargets.includes(target.id)) {
      excluded.push({ id: operation.id, reason: "target-excluded", details: [] });
      continue;
    }
    const reasons = target.unsupportedReasons(operation, catalog, options);
    if (reasons.length === 0) {
      included.push(operation);
      continue;
    }
    const severity = unsupportedPolicy === "fail" ? "error" : "warning";
    for (const reason of reasons) {
      diagnostics.push({ code: "SDK_UNSUPPORTED_OPERATION", severity, message: `${operation.id}: ${reason}`, operation: operation.id });
    }
    excluded.push({ id: operation.id, reason: "unsupported", details: reasons });
  }

  const pkg = target.packageOf(options);
  const generator: SdkGeneratorIdentity = { name: GENERATOR_NAME, version: GENERATOR_VERSION };
  const release = createReleaseDescriptor({ catalog, generator, artifacts: [{ kind: "sdk", target: target.id, package: pkg }] });
  if (!release.descriptor) {
    for (const diagnostic of release.diagnostics) {
      diagnostics.push({ code: "SDK_INVALID_RELEASE", severity: "error", message: diagnostic.message, pointer: diagnostic.pointer });
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return failed(diagnostics);

  const catalogDigest = canonicalDigest(catalog);
  const output = target.emit({
    catalog,
    catalogDigest,
    operations: included,
    options,
    generator,
    target: { id: target.id, version: target.version },
    releaseId: release.descriptor!.releaseId,
  });
  diagnostics.push(...output.diagnostics);
  diagnostics.push(...checkFiles(output.files, target.customCodeRoot));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return failed(diagnostics);

  const files = [...output.files].sort((a, b) => comparePaths(a.path, b.path));
  const manifest: SdkArtifactManifest = {
    manifestVersion: SDK_ARTIFACT_MANIFEST_VERSION,
    generator,
    target: { id: target.id, version: target.version },
    package: pkg,
    api: { id: catalog.api.id, version: catalog.api.version },
    catalog: { digest: catalogDigest, specDigest: catalog.source.specDigest, manifestDigest: catalog.source.manifestDigest },
    config: { digest: canonicalDigest({ target: target.id, unsupported: unsupportedPolicy, options }) },
    releaseId: release.descriptor!.releaseId,
    complete: !excluded.some((entry) => entry.reason === "unsupported"),
    operations: {
      included: included.map((operation) => ({ id: operation.id, name: operation.name })),
      excluded,
    },
    customCode: { root: target.customCodeRoot, seeds: files.filter((file) => file.ownership === "seed").map((file) => file.path) },
    files: files.filter((file) => file.ownership === "generated").map((file) => ({ path: file.path, sha256: sha256Hex(file.contents) })),
    diagnostics,
  };
  const manifestFile: SdkFile = { path: SDK_ARTIFACT_MANIFEST_FILE, contents: `${JSON.stringify(manifest, null, 2)}\n`, ownership: "generated" };
  return { ok: true, files: [...files, manifestFile].sort((a, b) => comparePaths(a.path, b.path)), manifest, diagnostics };
}

/** Target output must stay inside the package, keep seeds in the custom-code area and keep owned files out of it. */
function checkFiles(files: SdkFile[], customRoot: string): SdkDiagnostic[] {
  const diagnostics: SdkDiagnostic[] = [];
  const seen = new Map<string, string>();
  if (!isSafeRelativePath(customRoot.replace(/\/$/, "")) || !customRoot.endsWith("/")) {
    diagnostics.push({ code: "SDK_OUTPUT_CONFLICT", severity: "error", message: `Custom-code root "${customRoot}" must be a relative directory ending in "/".` });
  }
  for (const file of files) {
    const fold = file.path.toLowerCase();
    if (!isSafeRelativePath(file.path) || fold === SDK_ARTIFACT_MANIFEST_FILE || fold === SDK_OUTPUT_LOCK_FILE) {
      diagnostics.push({ code: "SDK_OUTPUT_CONFLICT", severity: "error", message: `Generated path "${file.path}" is not a safe package-relative path.`, pointer: file.path });
    } else if (seen.has(fold)) {
      // Case-insensitive file systems (macOS, Windows) would write both to one file.
      diagnostics.push({ code: "SDK_NAME_COLLISION", severity: "error", message: `Generated files "${seen.get(fold)}" and "${file.path}" collide.`, pointer: file.path });
    } else if ((file.ownership === "seed") !== file.path.startsWith(customRoot)) {
      diagnostics.push({ code: "SDK_OUTPUT_CONFLICT", severity: "error", message: `"${file.path}": seeds belong in ${customRoot} and owned files outside it.`, pointer: file.path });
    }
    seen.set(fold, file.path);
  }
  return diagnostics;
}
