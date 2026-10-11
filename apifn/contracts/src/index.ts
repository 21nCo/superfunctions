// @apifn/contracts — versioned API operation, release and client-failure contracts

export * from "./types.js";
export { buildOperationCatalog } from "./catalog.js";
export {
  validateManifest,
  isSupportedMediaType,
  API_ID_PATTERN,
  OPERATION_ID_PATTERN,
  NAME_PATTERN,
  TARGET_PATTERN,
  VERSION_PATTERN,
} from "./manifest.js";
export { createReleaseDescriptor, PACKAGE_NAME_PATTERN, RELEASE_ID_PATTERN, SEMVER_PATTERN } from "./release.js";
export { canonicalJson, canonicalDigest, sha256Hex } from "./canonical.js";
export { isCredentialKey, containsCredentialValue, containsCredentialIdentifier, CREDENTIAL_KEY_PATTERN } from "./credentials.js";
export * from "./failure-event.js";
