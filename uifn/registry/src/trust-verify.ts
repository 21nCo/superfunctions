// Typed entry point for the schema-v2 registry signature verifier. The implementation lives in
// trust-verify-core.mjs, which the static phase-16 gate also imports, so there is one copy of the rules.
export {
  REGISTRY_SIGNATURE_DOMAIN,
  REGISTRY_SIGNATURE_SCHEMA_VERSION,
  registryKeyId,
  registrySigningInput,
  verifyRegistrySignatureEnvelope,
  type RegistrySignatureEnvelope,
  type RegistrySignatureFailure,
  type RegistryTrustResult,
} from './trust-verify-core.mjs';
