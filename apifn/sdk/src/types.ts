// Public SDK generation contract. Every target (TypeScript here, Python in
// SFNS-18) implements `SdkTarget`; fields are versioned with the artifact
// manifest and change only additively within a version.

import type { CatalogOperation, OperationCatalog } from "@apifn/contracts";

export const SDK_ARTIFACT_MANIFEST_VERSION = "apifn.sdk-artifact/v1" as const;
/** Written at the root of every generated package. */
export const SDK_ARTIFACT_MANIFEST_FILE = "apifn.sdk-manifest.json" as const;

export type SdkDiagnosticCode =
  /** The catalog is not a valid apifn.operation-catalog/v1 document. */
  | "SDK_INVALID_CATALOG"
  /** The SDK config or target options are malformed or name an unknown target or operation. */
  | "SDK_INVALID_CONFIG"
  /** The target cannot express an operation; an error unless the config excludes unsupported operations. */
  | "SDK_UNSUPPORTED_OPERATION"
  /** Two generated identifiers or files would be the same. */
  | "SDK_NAME_COLLISION"
  /** A security scheme the target cannot inject; alternatives that need it are dropped. */
  | "SDK_UNSUPPORTED_SECURITY_SCHEME"
  /** Component schemas refer to each other in a cycle the target cannot type; the back-references are widened. */
  | "SDK_SCHEMA_CYCLE"
  /** Spec `servers` are recorded but never used as request destinations. */
  | "SDK_SERVERS_IGNORED"
  /** The release identity could not be derived (createReleaseDescriptor rejected the input). */
  | "SDK_INVALID_RELEASE"
  /** Writing would replace or delete a file the generator does not own, or leave the output directory. */
  | "SDK_OUTPUT_CONFLICT"
  /** An owned file was edited since the last generation; regeneration replaces it. */
  | "SDK_OWNED_FILE_MODIFIED";

export interface SdkDiagnostic {
  code: SdkDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  /** Stable operation ID when the diagnostic concerns one operation. */
  operation?: string;
  /** JSON pointer into the catalog or the SDK config, or a generated file path. */
  pointer?: string;
}

/** A generated file. Paths are relative POSIX paths inside the package root. */
export interface SdkFile {
  path: string;
  contents: string;
  /**
   * `generated` files are owned and rewritten on every generation.
   * `seed` files are written once, when missing, inside the custom-code area and never again.
   */
  ownership: "generated" | "seed";
}

/** The config file read by `apifn sdk generate`. */
export interface SdkConfig {
  /** Target ID, such as `typescript`. */
  target: string;
  /**
   * `fail` (default): an operation the target cannot express fails generation.
   * `exclude`: it is left out and listed under `operations.excluded` with reason `unsupported`.
   */
  unsupported?: "fail" | "exclude";
  /** Target-specific options, validated by the target. */
  options: unknown;
}

export interface SdkGeneratorIdentity {
  name: string;
  version: string;
}

/** Inputs every target receives; nothing else may influence its output. */
export interface SdkTargetContext<Options> {
  catalog: OperationCatalog;
  catalogDigest: string;
  /** Operations to generate, in catalog order: included for this target and supported. */
  operations: CatalogOperation[];
  options: Options;
  generator: SdkGeneratorIdentity;
  target: { id: string; version: string };
  /** Release identity embedded in generated clients for failure observations. */
  releaseId: string;
}

export interface SdkTargetOutput {
  files: SdkFile[];
  diagnostics: SdkDiagnostic[];
}

/** A generator/build adapter for one SDK language or runtime. */
export interface SdkTarget<Options = unknown> {
  /** Stable target ID (`^[a-z][a-z0-9-]*$`), matched against `sdk.excludeTargets` in the manifest. */
  readonly id: string;
  /** Pinned target version (SemVer); any change to generated output bumps it. */
  readonly version: string;
  /** Directory, relative to the package root and ending in `/`, that generation never rewrites. */
  readonly customCodeRoot: string;
  /** Validates target options and applies defaults. Unknown fields are errors. */
  resolveOptions(input: unknown, catalog: OperationCatalog): { options: Options | null; diagnostics: SdkDiagnostic[] };
  /** Package identity recorded in the artifact manifest and release identity. */
  packageOf(options: Options): { name: string; version: string };
  /** Why the target cannot express an operation; an empty list means supported. */
  unsupportedReasons(operation: CatalogOperation, catalog: OperationCatalog, options: Options): string[];
  /**
   * Emits the package. Must be deterministic: same context, same bytes. Generated names that would
   * collide, including operation names the language reserves or calls implicitly on a client object
   * (TypeScript: `constructor`, `then`, `toJSON` and `Object.prototype` members), are `SDK_NAME_COLLISION` errors.
   */
  emit(context: SdkTargetContext<Options>): SdkTargetOutput;
}

export type SdkExclusionReason = "sdk-include-false" | "target-excluded" | "unsupported";

/** Provenance and contents of one generated package (`apifn.sdk-manifest.json`). */
export interface SdkArtifactManifest {
  manifestVersion: typeof SDK_ARTIFACT_MANIFEST_VERSION;
  generator: SdkGeneratorIdentity;
  target: { id: string; version: string };
  package: { name: string; version: string };
  api: { id: string; version: string };
  catalog: { digest: string; specDigest: string; manifestDigest: string };
  config: { digest: string };
  releaseId: string;
  /** False when unsupported operations were excluded: the artifact does not cover the catalog's SDK operations. */
  complete: boolean;
  operations: {
    included: Array<{ id: string; name: string }>;
    excluded: Array<{ id: string; reason: SdkExclusionReason; details: string[] }>;
  };
  customCode: { root: string; seeds: string[] };
  /** Owned files with the sha256 of their contents; the manifest itself is not listed. */
  files: Array<{ path: string; sha256: string }>;
  /** Warnings from generation; a manifest is only written when there are no errors. */
  diagnostics: SdkDiagnostic[];
}

export interface SdkGenerationResult {
  ok: boolean;
  /** All files to write, including the artifact manifest, sorted by path; empty when `ok` is false. */
  files: SdkFile[];
  manifest: SdkArtifactManifest | null;
  diagnostics: SdkDiagnostic[];
}
