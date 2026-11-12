import { REGISTRY_CATALOG_PAYLOAD_JSON } from './generated/catalog';
import { REGISTRY_SIGNATURE } from './generated/signature';
import { REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM } from './trust-root';
import { verifyRegistrySignatureEnvelope, type RegistryTrustResult } from './trust-verify';

export {
  REGISTRY_SIGNATURE_DOMAIN,
  REGISTRY_SIGNATURE_SCHEMA_VERSION,
  type RegistrySignatureEnvelope,
  type RegistrySignatureFailure,
  type RegistryTrustResult,
} from './trust-verify';
export { REGISTRY_TRUST_ROOT_KEY_ID } from './trust-root';

/**
 * Verifies the registry catalog against the pinned KMS trust root with the schema-v2 signature envelope.
 * Only schema v2 is accepted; any failure returns `UIFN_REGISTRY_SIGNATURE_INVALID`.
 */
export function verifyRegistryCatalogSignature(
  payload: string = REGISTRY_CATALOG_PAYLOAD_JSON,
  signature: unknown = REGISTRY_SIGNATURE,
): RegistryTrustResult {
  return verifyRegistrySignatureEnvelope(payload, signature, REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM);
}
