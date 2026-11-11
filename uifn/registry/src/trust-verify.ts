import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/** Domain of the schema-v2 registry signature. The signed input is UTF8(domain + "\0") || SHA-256(catalog-bytes). */
export const REGISTRY_SIGNATURE_DOMAIN = 'uifn-registry-v2';
export const REGISTRY_SIGNATURE_SCHEMA_VERSION = 2;

const DOMAIN_PREFIX = Buffer.from(`${REGISTRY_SIGNATURE_DOMAIN}\0`, 'utf8');
const ENVELOPE_FIELDS = ['algorithm', 'catalogSha256', 'domain', 'keyId', 'schemaVersion', 'signatureBase64'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{24}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SIGNATURE_BYTES = 64;

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
  /** Key id of the pinned trust root the catalog was checked against. */
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

const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

/** Registry key id: the first 24 hex characters of SHA-256 over the SPKI DER public key. */
export function registryKeyId(publicKey: KeyObject): string {
  return sha256(publicKey.export({ type: 'spki', format: 'der' })).toString('hex').slice(0, 24);
}

/** Schema-v2 signed input, computed from the catalog bytes: UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes). */
export function registrySigningInput(catalogBytes: Uint8Array): Buffer {
  return Buffer.concat([DOMAIN_PREFIX, sha256(catalogBytes)]);
}

type EnvelopeFields = Record<(typeof ENVELOPE_FIELDS)[number], unknown>;

/**
 * Copies the envelope's own data properties into a plain record. Only own property descriptors are read, so an
 * accessor property is rejected instead of being invoked. A value that is not a plain object with exactly the
 * schema-v2 fields is malformed; an envelope whose schemaVersion is not 2 (such as a v1 envelope, which has no
 * domain field) is reported as an unsupported schema.
 */
function readEnvelope(value: unknown): { fields: EnvelopeFields } | { reason: RegistrySignatureFailure } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { reason: 'envelope-malformed' };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { reason: 'envelope-malformed' };
  const schema = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (!schema || !('value' in schema)) return { reason: 'envelope-malformed' };
  if (schema.value !== REGISTRY_SIGNATURE_SCHEMA_VERSION) return { reason: 'schema-unsupported' };
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ENVELOPE_FIELDS.length) return { reason: 'envelope-malformed' };
  const fields = {} as EnvelopeFields;
  for (const field of ENVELOPE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) return { reason: 'envelope-malformed' };
    fields[field] = descriptor.value;
  }
  return { fields };
}

/**
 * Verifies a schema-v2 registry signature envelope over `catalog` against `trustRootPem`.
 *
 * The verifier computes the catalog digest and the domain-separated signed input itself. The envelope's
 * `catalogSha256` must equal the computed digest, but it is never used as the signed input. Schema v1
 * envelopes, other domains, other keys, other algorithms and malformed envelopes are rejected.
 */
export function verifyRegistrySignatureEnvelope(
  catalog: string | Uint8Array,
  envelope: unknown,
  trustRootPem: string,
): RegistryTrustResult {
  const catalogBytes = typeof catalog === 'string' ? Buffer.from(catalog, 'utf8') : Buffer.from(catalog);
  const catalogSha256 = sha256(catalogBytes).toString('hex');
  let trustRoot: KeyObject;
  let keyId: string;
  try {
    trustRoot = createPublicKey(trustRootPem);
    if (trustRoot.asymmetricKeyType !== 'ed25519') throw new Error('trust root is not Ed25519');
    keyId = registryKeyId(trustRoot);
  } catch {
    return { ok: false, code: 'UIFN_REGISTRY_SIGNATURE_INVALID', reason: 'trust-root-invalid', keyId: '', catalogSha256 };
  }
  const fail = (reason: RegistrySignatureFailure): RegistryTrustResult => (
    { ok: false, code: 'UIFN_REGISTRY_SIGNATURE_INVALID', reason, keyId, catalogSha256 }
  );

  let envelopeRead: ReturnType<typeof readEnvelope>;
  try {
    envelopeRead = readEnvelope(envelope);
  } catch {
    // A proxy trap that throws is a malformed envelope.
    return fail('envelope-malformed');
  }
  if ('reason' in envelopeRead) return fail(envelopeRead.reason);
  const { fields } = envelopeRead;
  if (fields.algorithm !== 'Ed25519') return fail('algorithm-unsupported');
  if (fields.domain !== REGISTRY_SIGNATURE_DOMAIN) return fail('domain-mismatch');
  if (typeof fields.keyId !== 'string' || !KEY_ID.test(fields.keyId)) return fail('envelope-malformed');
  if (fields.keyId !== keyId) return fail('key-mismatch');
  if (typeof fields.catalogSha256 !== 'string' || !SHA256_HEX.test(fields.catalogSha256)) return fail('envelope-malformed');
  if (fields.catalogSha256 !== catalogSha256) return fail('digest-mismatch');
  if (typeof fields.signatureBase64 !== 'string' || !BASE64.test(fields.signatureBase64)) return fail('envelope-malformed');
  const signature = Buffer.from(fields.signatureBase64, 'base64');
  if (signature.length !== ED25519_SIGNATURE_BYTES) return fail('envelope-malformed');

  let valid = false;
  try {
    valid = verify(null, registrySigningInput(catalogBytes), trustRoot, signature);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, keyId, catalogSha256 } : fail('signature-invalid');
}
