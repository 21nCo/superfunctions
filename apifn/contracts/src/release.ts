import { canonicalDigest, canonicalJson, compareCodeUnits, snapshotPlainData } from "./canonical.js";
import { containsCredentialIdentifier, quote, sanitizeReport } from "./credentials.js";
import { API_ID_PATTERN, OPERATION_ID_PATTERN, POLICY_REF_PATTERN, TARGET_PATTERN, VERSION_PATTERN } from "./manifest.js";
import {
  CATALOG_VERSION,
  RELEASE_DESCRIPTOR_VERSION,
  type CreateReleaseInput,
  type CreateReleaseResult,
  type Diagnostic,
  type ReleaseArtifact,
  type ReleaseDescriptor,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
/** SemVer 2.0.0: no leading zeros in numbers or numeric prerelease identifiers, and no empty identifiers. */
export const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A descriptor string field: the same pattern and length bound as release-descriptor.v1. */
interface FieldRule {
  pattern: RegExp;
  maxLength: number;
  what: string;
}

const RULES = {
  apiId: { pattern: API_ID_PATTERN, maxLength: 128, what: "an API ID" },
  apiVersion: { pattern: VERSION_PATTERN, maxLength: 64, what: "an API version" },
  digest: { pattern: DIGEST_PATTERN, maxLength: 71, what: "a sha256:<hex> digest" },
  operationId: { pattern: OPERATION_ID_PATTERN, maxLength: 128, what: "a stable operation ID" },
  generatorName: { pattern: PACKAGE_NAME_PATTERN, maxLength: 214, what: "a package name such as @apifn/sdk-typescript" },
  generatorVersion: { pattern: SEMVER_PATTERN, maxLength: 64, what: "a semantic version such as 1.4.0" },
  releaseId: { pattern: RELEASE_ID_PATTERN, maxLength: 128, what: "a release ID" },
  target: { pattern: TARGET_PATTERN, maxLength: 32, what: "a target such as typescript" },
  packageName: { pattern: PACKAGE_NAME_PATTERN, maxLength: 214, what: "a registry package name" },
  packageVersion: { pattern: VERSION_PATTERN, maxLength: 64, what: "a registry version string" },
  executionPolicyRef: { pattern: POLICY_REF_PATTERN, maxLength: 128, what: "an execution policy reference" },
} satisfies Record<string, FieldRule>;

/** True for a string that satisfies the field's schema bounds and holds no credential. */
function matches(value: unknown, rule: FieldRule): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= rule.maxLength &&
    rule.pattern.test(value) &&
    !containsCredentialIdentifier(value)
  );
}

/**
 * Describes one release of generated artifacts for a catalog. Versioning is
 * explicit and separate: descriptor schema version, API version, spec and
 * manifest digests, catalog digest, generator version, each package version
 * and the release ID. Without an explicit `releaseId` the ID is derived from
 * the descriptor content, so identical inputs yield identical descriptors.
 */
export function createReleaseDescriptor(input: CreateReleaseInput): CreateReleaseResult {
  const diagnostics: Diagnostic[] = [];
  const fail = (pointer: string, message: string) =>
    diagnostics.push({ code: "INVALID_RELEASE", severity: "error", ...sanitizeReport(pointer, message), source: "release" });
  // Read the input once: getters cannot change a value after it was checked.
  let snapshot: ReturnType<typeof snapshotPlainData>;
  try {
    snapshot = snapshotPlainData(input);
  } catch {
    fail("", "Release input must be plain JSON data; reading it threw.");
    return { descriptor: null, diagnostics };
  }
  for (const { pointer, reason } of snapshot.problems) fail(pointer, `${pointer || "Release input"} ${reason}.`);
  if (diagnostics.length > 0) return { descriptor: null, diagnostics };
  const data = snapshot.value;
  if (!isRecord(data)) {
    fail("", "Release input must be a plain object with catalog, generator and artifacts.");
    return { descriptor: null, diagnostics };
  }
  const check = (value: unknown, pointer: string, rule: FieldRule): value is string => {
    if (matches(value, rule)) return true;
    fail(pointer, `Expected ${rule.what} of at most ${rule.maxLength} characters matching ${rule.pattern.source}, without credentials.`);
    return false;
  };

  const catalog = data.catalog;
  if (!isRecord(catalog) || catalog.catalogVersion !== CATALOG_VERSION) {
    fail("/catalog/catalogVersion", `Expected a ${CATALOG_VERSION} catalog built by buildOperationCatalog.`);
    return { descriptor: null, diagnostics };
  }
  const api = isRecord(catalog.api) ? catalog.api : {};
  const source = isRecord(catalog.source) ? catalog.source : {};
  check(api.id, "/catalog/api/id", RULES.apiId);
  check(api.version, "/catalog/api/version", RULES.apiVersion);
  check(source.specDigest, "/catalog/source/specDigest", RULES.digest);
  check(source.manifestDigest, "/catalog/source/manifestDigest", RULES.digest);
  const operations: Array<{ id: string; sdkInclude: boolean; excludedTargets: string[]; agentExpose: boolean }> = [];
  if (!Array.isArray(catalog.operations)) {
    fail("/catalog/operations", "Catalog operations must be an array as built by buildOperationCatalog.");
  } else {
    catalog.operations.forEach((operation, index) => {
      const pointer = `/catalog/operations/${index}`;
      const sdk = isRecord(operation) && isRecord(operation.sdk) ? operation.sdk : {};
      const agent = isRecord(operation) && isRecord(operation.agent) ? operation.agent : {};
      const id = isRecord(operation) ? operation.id : undefined;
      if (!check(id, `${pointer}/id`, RULES.operationId)) return;
      const excluded = sdk.excludedTargets;
      if (typeof sdk.include !== "boolean" || !Array.isArray(excluded) || excluded.some((target) => typeof target !== "string") || typeof agent.expose !== "boolean") {
        fail(pointer, `Operation ${pointer} needs sdk.include, sdk.excludedTargets and agent.expose as built by buildOperationCatalog.`);
        return;
      }
      // Exposure without a policy is never listed in agent tools: method and schema imply no authorization (operation-catalog.v1 requires it too).
      if (agent.expose && !check((operation as Record<string, unknown>).executionPolicyRef, `${pointer}/executionPolicyRef`, RULES.executionPolicyRef)) return;
      operations.push({ id, sdkInclude: sdk.include, excludedTargets: excluded as string[], agentExpose: agent.expose });
    });
  }
  let catalogDigest = "";
  try {
    catalogDigest = canonicalDigest(catalog);
  } catch {
    fail("/catalog", "Catalog must be plain JSON data (no non-finite numbers or functions).");
  }

  const generator = isRecord(data.generator) ? data.generator : {};
  check(generator.name, "/generator/name", RULES.generatorName);
  check(generator.version, "/generator/version", RULES.generatorVersion);
  if (data.releaseId !== undefined) check(data.releaseId, "/releaseId", RULES.releaseId);
  if (!Array.isArray(data.artifacts) || data.artifacts.length === 0) {
    fail("/artifacts", "A release needs at least one artifact.");
  }

  const seen = new Set<string>();
  const artifacts: ReleaseArtifact[] = [];
  (Array.isArray(data.artifacts) ? data.artifacts : []).forEach((artifact: unknown, index) => {
    const pointer = `/artifacts/${index}`;
    const entry = isRecord(artifact) ? artifact : {};
    if (entry.kind !== "sdk" && entry.kind !== "agent-tools") {
      fail(`${pointer}/kind`, 'Artifact kind must be "sdk" or "agent-tools".');
      return;
    }
    const kind = entry.kind;
    if (!check(entry.target, `${pointer}/target`, RULES.target)) return;
    const target = entry.target;
    const pkg = isRecord(entry.package) ? entry.package : {};
    const nameOk = check(pkg.name, `${pointer}/package/name`, RULES.packageName);
    const versionOk = check(pkg.version, `${pointer}/package/version`, RULES.packageVersion);
    const key = `${kind}:${target}`;
    if (seen.has(key)) {
      fail(pointer, `Release already has a ${kind} artifact for target ${quote(target)}.`);
      return;
    }
    seen.add(key);
    if (!nameOk || !versionOk) return;
    const ids = operations
      .filter((operation) =>
        kind === "sdk" ? operation.sdkInclude && !operation.excludedTargets.includes(target) : operation.agentExpose
      )
      .map((operation) => operation.id)
      .sort(compareCodeUnits);
    artifacts.push({ kind, target, package: { name: pkg.name as string, version: pkg.version as string }, operations: ids });
  });

  if (diagnostics.length > 0) return { descriptor: null, diagnostics };

  artifacts.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.target, b.target));
  const body: Omit<ReleaseDescriptor, "releaseId"> = {
    descriptorVersion: RELEASE_DESCRIPTOR_VERSION,
    api: { id: api.id as string, version: api.version as string },
    catalogDigest,
    specDigest: source.specDigest as string,
    manifestDigest: source.manifestDigest as string,
    generator: { name: generator.name as string, version: generator.version as string },
    artifacts,
  };
  const releaseId = (data.releaseId as string | undefined) ?? `rel_${canonicalDigest(body).slice("sha256:".length, "sha256:".length + 24)}`;
  return { descriptor: JSON.parse(canonicalJson({ ...body, releaseId })) as ReleaseDescriptor, diagnostics };
}
