// Single implementation of the schema-v2 registry signature contract. The runtime verifier (trust-verify.ts) and the
// static phase-16 gate (scripts/verify-uifn-phase-16.mjs) both import this file, so the two cannot drift apart. It
// is plain ESM so the phase-16 script can load it with Node alone; trust-verify-core.d.mts declares its types.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { types } from 'node:util';

/** Domain of the schema-v2 registry signature. The signed input is UTF8(domain + "\0") || SHA-256(catalog-bytes). */
export const REGISTRY_SIGNATURE_DOMAIN = 'uifn-registry-v2';
export const REGISTRY_SIGNATURE_SCHEMA_VERSION = 2;

const DOMAIN_PREFIX = Buffer.from(`${REGISTRY_SIGNATURE_DOMAIN}\0`, 'utf8');
const ENVELOPE_FIELDS = ['algorithm', 'catalogSha256', 'domain', 'keyId', 'schemaVersion', 'signatureBase64'];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{24}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SIGNATURE_BYTES = 64;
/** Padded Base64 length of a 64-byte Ed25519 signature; checked before any regex or decoding runs. */
const ED25519_SIGNATURE_BASE64_LENGTH = 88;
const INVALID = 'UIFN_REGISTRY_SIGNATURE_INVALID';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

/** Registry key id: the first 24 hex characters of SHA-256 over the SPKI DER public key. */
export function registryKeyId(publicKey) {
  return sha256(publicKey.export({ type: 'spki', format: 'der' })).toString('hex').slice(0, 24);
}

/** Schema-v2 signed input, computed from the catalog bytes: UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes). */
export function registrySigningInput(catalogBytes) {
  return Buffer.concat([DOMAIN_PREFIX, sha256(catalogBytes)]);
}

/**
 * Parses the trust root and derives its key id. A malformed or empty PEM and any key that is not Ed25519 (EC, RSA)
 * yield null instead of throwing.
 */
function readTrustRoot(trustRootPem) {
  try {
    const key = createPublicKey(trustRootPem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return { key, keyId: registryKeyId(key) };
  } catch {
    return null;
  }
}

/**
 * Built-ins whose internal slots can hold caller storage (binary buffers, collections, error causes, strings, regular
 * expressions) or that wrap engine or host state. They are rejected by their internal-slot predicates, which read no
 * properties and run no caller code, before structuredClone could copy or walk them. These predicates work across
 * realms.
 */
const SLOT_BEARING = [
  types.isAnyArrayBuffer,
  types.isArrayBufferView,
  types.isMap,
  types.isSet,
  types.isWeakMap,
  types.isWeakSet,
  types.isNativeError,
  types.isDate,
  types.isRegExp,
  types.isBoxedPrimitive,
  types.isPromise,
  types.isGeneratorObject,
  types.isMapIterator,
  types.isSetIterator,
  types.isArgumentsObject,
  types.isModuleNamespaceObject,
  types.isKeyObject,
  types.isCryptoKey,
  types.isExternal,
];

/**
 * True when `value` is an ordinary object as far as the engine can tell. The cheap internal-slot predicates in
 * SLOT_BEARING run first, so no caller-owned storage is ever copied. The remaining value must then structured-clone to
 * an ordinary object; by now it can hold only its six primitive own fields, so the clone is bounded by the envelope.
 * Any other slot-bearing built-in keeps its type through the clone or cannot be cloned (Intl objects, other iterators,
 * WeakRef, FinalizationRegistry). The clone's prototype is compared with that of a clone of {} made by the same
 * structuredClone, not with this realm's Object.prototype, so the answer does not depend on which realm's
 * structuredClone is in scope. Private class fields (#x) are invisible to every JavaScript check; the verifier never
 * reads them, so such a carrier is judged by its six own data fields alone.
 */
function isOrdinaryRecord(value) {
  if (SLOT_BEARING.some((isSlotBearing) => isSlotBearing(value))) return false;
  try {
    return Object.getPrototypeOf(structuredClone(value)) === Object.getPrototypeOf(structuredClone({}));
  } catch {
    return false;
  }
}

/**
 * Copies the envelope's own data properties into a plain record. A Proxy is rejected before any reflective
 * operation, so none of its traps run. Only own property descriptors are read, so an accessor property is rejected
 * instead of being invoked. A value that is not a plain object with exactly the schema-v2 fields, each holding a
 * primitive, is malformed; an envelope whose schemaVersion is not 2 (such as a v1 envelope, which has no domain field)
 * is an unsupported schema.
 *
 * A built-in with internal slots is malformed even when its prototype was reset to Object.prototype or null (see
 * isOrdinaryRecord). That check runs only after every field is known to be an own data property holding a primitive,
 * so it cannot reach caller code.
 */
function readEnvelope(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return { reason: 'envelope-malformed' };
  if (Array.isArray(value)) return { reason: 'envelope-malformed' };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { reason: 'envelope-malformed' };
  const schema = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (!schema || !('value' in schema)) return { reason: 'envelope-malformed' };
  if (schema.value !== REGISTRY_SIGNATURE_SCHEMA_VERSION) return { reason: 'schema-unsupported' };
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ENVELOPE_FIELDS.length) return { reason: 'envelope-malformed' };
  const fields = {};
  for (const field of ENVELOPE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) return { reason: 'envelope-malformed' };
    const fieldValue = descriptor.value;
    if (fieldValue !== null && (typeof fieldValue === 'object' || typeof fieldValue === 'function')) return { reason: 'envelope-malformed' };
    fields[field] = fieldValue;
  }
  if (!isOrdinaryRecord(value)) return { reason: 'envelope-malformed' };
  return { fields };
}

/**
 * Verifies a schema-v2 registry signature envelope over `catalog` against `trustRootPem`. Never throws.
 *
 * The verifier computes the catalog digest and the domain-separated signed input itself. The envelope's
 * `catalogSha256` must equal the computed digest, but it is never used as the signed input. Schema v1
 * envelopes, other domains, other keys, other algorithms, non-Ed25519 trust roots and malformed envelopes are
 * rejected with UIFN_REGISTRY_SIGNATURE_INVALID.
 */
export function verifyRegistrySignatureEnvelope(catalog, envelope, trustRootPem) {
  const catalogBytes = typeof catalog === 'string' ? Buffer.from(catalog, 'utf8') : Buffer.from(catalog);
  const catalogSha256 = sha256(catalogBytes).toString('hex');
  const trustRoot = readTrustRoot(trustRootPem);
  if (!trustRoot) return { ok: false, code: INVALID, reason: 'trust-root-invalid', keyId: '', catalogSha256 };
  const { key, keyId } = trustRoot;
  const fail = (reason) => ({ ok: false, code: INVALID, reason, keyId, catalogSha256 });

  let envelopeRead;
  try {
    envelopeRead = readEnvelope(envelope);
  } catch {
    // Defensive: proxies are rejected before reflection, so an ordinary envelope cannot throw here.
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
  const { signatureBase64 } = fields;
  if (typeof signatureBase64 !== 'string' || signatureBase64.length !== ED25519_SIGNATURE_BASE64_LENGTH) return fail('envelope-malformed');
  if (!BASE64.test(signatureBase64)) return fail('envelope-malformed');
  const signature = Buffer.from(signatureBase64, 'base64');
  // Canonical encoding only: Buffer.from ignores nonzero unused pad bits, so the decoded bytes must re-encode exactly.
  if (signature.length !== ED25519_SIGNATURE_BYTES || signature.toString('base64') !== signatureBase64) {
    return fail('envelope-malformed');
  }

  let valid = false;
  try {
    valid = verify(null, registrySigningInput(catalogBytes), key, signature);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, keyId, catalogSha256 } : fail('signature-invalid');
}
