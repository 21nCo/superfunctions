import { canonicalDigest, canonicalJson, compareCodeUnits } from "./canonical.js";
import { TARGET_PATTERN, VERSION_PATTERN } from "./manifest.js";
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Fields of a catalog that a release reads; anything else is checked by the catalog's own schema. */
function isReleasableCatalog(catalog: unknown): catalog is CreateReleaseInput["catalog"] {
  if (!isRecord(catalog) || !isRecord(catalog.api) || !isRecord(catalog.source) || !Array.isArray(catalog.operations)) return false;
  const { api, source } = catalog;
  return (
    typeof api.id === "string" &&
    typeof api.version === "string" &&
    typeof source.specDigest === "string" &&
    typeof source.manifestDigest === "string" &&
    catalog.operations.every(
      (operation) =>
        isRecord(operation) &&
        typeof operation.id === "string" &&
        isRecord(operation.sdk) &&
        typeof operation.sdk.include === "boolean" &&
        Array.isArray(operation.sdk.excludedTargets) &&
        isRecord(operation.agent) &&
        typeof operation.agent.expose === "boolean"
    )
  );
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

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
    diagnostics.push({ code: "INVALID_RELEASE", severity: "error", message, pointer, source: "release" });
  if (!isRecord(input)) {
    fail("", "Release input must be a plain object with catalog, generator and artifacts.");
    return { descriptor: null, diagnostics };
  }
  const { catalog, generator } = input;

  if (!isRecord(catalog) || catalog.catalogVersion !== CATALOG_VERSION) {
    fail("/catalog/catalogVersion", `Expected a ${CATALOG_VERSION} catalog built by buildOperationCatalog.`);
    return { descriptor: null, diagnostics };
  }
  let catalogDigest = "";
  try {
    catalogDigest = canonicalDigest(catalog);
  } catch {
    // Falls through to the shape error below: a catalog is plain JSON data.
  }
  if (!isReleasableCatalog(catalog) || catalogDigest === "") {
    fail("/catalog", "Catalog is not plain JSON with api, source and operations as built by buildOperationCatalog.");
    return { descriptor: null, diagnostics };
  }
  if (typeof generator?.name !== "string" || !PACKAGE_NAME_PATTERN.test(generator.name)) {
    fail("/generator/name", "Generator name must be a package name such as @apifn/sdk-typescript.");
  }
  if (typeof generator?.version !== "string" || !SEMVER_PATTERN.test(generator.version)) {
    fail("/generator/version", "Generator version must be a semantic version such as 1.4.0.");
  }
  if (input.releaseId !== undefined && (typeof input.releaseId !== "string" || !RELEASE_ID_PATTERN.test(input.releaseId))) {
    fail("/releaseId", `Release ID must match ${RELEASE_ID_PATTERN.source}.`);
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
    fail("/artifacts", "A release needs at least one artifact.");
  }

  const seen = new Set<string>();
  const artifacts: ReleaseArtifact[] = [];
  (Array.isArray(input.artifacts) ? input.artifacts : []).forEach((artifact, index) => {
    const pointer = `/artifacts/${index}`;
    if (artifact?.kind !== "sdk" && artifact?.kind !== "agent-tools") {
      fail(`${pointer}/kind`, 'Artifact kind must be "sdk" or "agent-tools".');
      return;
    }
    if (typeof artifact.target !== "string" || !TARGET_PATTERN.test(artifact.target) || artifact.target.length > 32) {
      fail(`${pointer}/target`, `Artifact target must match ${TARGET_PATTERN.source}.`);
      return;
    }
    const name = artifact.package?.name;
    const version = artifact.package?.version;
    if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME_PATTERN.test(name)) {
      fail(`${pointer}/package/name`, "Artifact package name must be a registry package name.");
    }
    if (typeof version !== "string" || version.length > 64 || !VERSION_PATTERN.test(version)) {
      fail(`${pointer}/package/version`, "Artifact package version must be a registry version string.");
    }
    const key = `${artifact.kind}:${artifact.target}`;
    if (seen.has(key)) {
      fail(pointer, `Release already has a ${artifact.kind} artifact for target "${artifact.target}".`);
      return;
    }
    seen.add(key);
    const operations = catalog.operations
      .filter((operation) =>
        artifact.kind === "sdk"
          ? operation.sdk.include && !operation.sdk.excludedTargets.includes(artifact.target)
          : operation.agent.expose
      )
      .map((operation) => operation.id)
      .sort(compareCodeUnits);
    artifacts.push({ kind: artifact.kind, target: artifact.target, package: { name, version }, operations });
  });

  if (diagnostics.length > 0) return { descriptor: null, diagnostics };

  artifacts.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.target, b.target));
  const body: Omit<ReleaseDescriptor, "releaseId"> = {
    descriptorVersion: RELEASE_DESCRIPTOR_VERSION,
    api: { id: catalog.api.id, version: catalog.api.version },
    catalogDigest,
    specDigest: catalog.source.specDigest,
    manifestDigest: catalog.source.manifestDigest,
    generator: { name: generator.name, version: generator.version },
    artifacts,
  };
  const releaseId = input.releaseId ?? `rel_${canonicalDigest(body).slice("sha256:".length, "sha256:".length + 24)}`;
  return { descriptor: JSON.parse(canonicalJson({ ...body, releaseId })) as ReleaseDescriptor, diagnostics };
}
