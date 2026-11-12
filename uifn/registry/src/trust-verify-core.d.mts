import type { KeyObject } from 'node:crypto';

/** Domain of the schema-v2 registry signature. The signed input is UTF8(domain + "\0") || SHA-256(catalog-bytes). */
export declare const REGISTRY_SIGNATURE_DOMAIN: 'uifn-registry-v2';
export declare const REGISTRY_SIGNATURE_SCHEMA_VERSION: 2;

export type RegistrySignatureFailure =
  | 'envelope-malformed'
  | 'schema-unsupported'
  | 'algorithm-unsupported'
  | 'domain-mismatch'
  | 'key-mismatch'
  | 'digest-mismatch'
  | 'signature-invalid'
  | 'trust-root-invalid';

export interface RegistryTrustResult {
  ok: boolean;
  code?: 'UIFN_REGISTRY_SIGNATURE_INVALID';
  /** Why verification failed; absent when `ok` is true. */
  reason?: RegistrySignatureFailure;
  /** Key id of the trust root the catalog was checked against; empty when the trust root is unusable. */
  keyId: string;
  /** SHA-256 of the catalog bytes, computed by the verifier. */
  catalogSha256: string;
}

/** Schema-v2 detached signature envelope, as written by the KMS release-signing workflow. */
export interface RegistrySignatureEnvelope {
  readonly schemaVersion: 2;
  readonly algorithm: 'Ed25519';
  readonly domain: 'uifn-registry-v2';
  readonly keyId: string;
  readonly catalogSha256: string;
  readonly signatureBase64: string;
}

/** Registry key id: the first 24 hex characters of SHA-256 over the SPKI DER public key. */
export declare function registryKeyId(publicKey: KeyObject): string;

/** Schema-v2 signed input, computed from the catalog bytes: UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes). */
export declare function registrySigningInput(catalogBytes: Uint8Array): Buffer;

/** Verifies a schema-v2 registry signature envelope over `catalog` against `trustRootPem`. Never throws. */
export declare function verifyRegistrySignatureEnvelope(
  catalog: string | Uint8Array,
  envelope: unknown,
  trustRootPem: string,
): RegistryTrustResult;
