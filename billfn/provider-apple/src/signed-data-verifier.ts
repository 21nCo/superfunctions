/**
 * Verifies App Store signed data (App Store Server Notifications v2 and signed transactions) on WebCrypto, so it runs
 * on Workers: an ES256 JWS whose x5c chain is leaf, Apple WWDR intermediate and the pinned Apple Root CA - G3, with
 * Apple's OIDs on the leaf and intermediate, every certificate valid now, and the payload for the configured app.
 */
import { APPLE_ROOT_CA_G3, APPLE_ROOT_CA_G3_SHA256 } from './apple-root-ca.js';
import { base64ToBytes, base64UrlToBytes, bytesEqual, bytesToHex, toArrayBuffer } from './encoding.js';
import { importCertificateKey, isIssuedBy, parseCertificate, type X509Certificate } from './x509.js';

/** Apple's marker extension on the App Store receipt signing leaf certificate. */
export const APPLE_SIGNING_LEAF_OID = '1.2.840.113635.100.6.11.1';
/** Apple's marker extension on the Apple Worldwide Developer Relations intermediate certificate. */
export const APPLE_WWDR_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

export type AppleEnvironment = 'production' | 'sandbox';

export type AppleSignedDataVerificationFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'untrusted_root'
  | 'invalid_chain'
  | 'missing_apple_oid'
  | 'certificate_expired'
  | 'signature_invalid'
  | 'bundle_id_mismatch'
  | 'environment_unsupported';

export class AppleSignedDataVerificationError extends Error {
  readonly reason: AppleSignedDataVerificationFailure;

  constructor(reason: AppleSignedDataVerificationFailure, message: string) {
    super(message);
    this.name = 'AppleSignedDataVerificationError';
    this.reason = reason;
  }
}

export interface AppleSignedDataVerifierOptions {
  /** The app's bundle ID; signed data for any other app is rejected. */
  bundleId: string;
  /** The clock certificate validity is checked against. Defaults to the current time. */
  now?: () => Date;
}

export interface AppleVerifiedSignedData {
  payload: Record<string, unknown>;
  /** The App Store environment the payload names; both are accepted. */
  environment: AppleEnvironment;
}

export interface AppleSignedDataVerifier {
  /** Verifies the `signedPayload` of an App Store Server Notification v2. */
  verifyNotification(signedPayload: string): Promise<AppleVerifiedSignedData>;
  /** Verifies a JWS signed transaction (`signedTransactionInfo`, or StoreKit 2's `jwsRepresentation`). */
  verifyTransaction(signedTransaction: string): Promise<AppleVerifiedSignedData>;
}

interface TrustAnchor {
  certificate: X509Certificate;
}

let pinnedAppleRoot: Promise<TrustAnchor> | undefined;

/** Loads the bundled root once, and only if its SHA-256 equals the pin. */
function loadPinnedAppleRoot(): Promise<TrustAnchor> {
  pinnedAppleRoot ??= (async () => {
    const der = base64ToBytes(APPLE_ROOT_CA_G3);
    const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(der))));
    if (digest !== APPLE_ROOT_CA_G3_SHA256) {
      throw new Error('The bundled Apple Root CA - G3 does not match its pinned SHA-256');
    }
    return { certificate: parseCertificate(der) };
  })();
  return pinnedAppleRoot;
}

/** Verifies App Store signed data against the bundled, SHA-256-pinned Apple Root CA - G3. */
export function createAppleSignedDataVerifier(options: AppleSignedDataVerifierOptions): AppleSignedDataVerifier {
  return createVerifier(options, loadPinnedAppleRoot);
}

/**
 * Verifies against another root, given as base64 DER. Not exported from the package: the provider always pins Apple's
 * root, and this exists so Apple's published test chains and generated chains can exercise the same code.
 */
export function createAppleSignedDataVerifierForRoot(
  options: AppleSignedDataVerifierOptions & { rootCertificate: string }
): AppleSignedDataVerifier {
  const anchor = Promise.resolve().then(() => ({ certificate: parseCertificate(base64ToBytes(options.rootCertificate)) }));
  return createVerifier(options, () => anchor);
}

function createVerifier(
  options: AppleSignedDataVerifierOptions,
  loadRoot: () => Promise<TrustAnchor>
): AppleSignedDataVerifier {
  if (typeof options.bundleId !== 'string' || options.bundleId.length === 0) {
    throw new TypeError('The Apple signed data verifier requires a bundleId');
  }
  const now = options.now ?? (() => new Date());
  const verify = async (jws: string, readScope: (payload: Record<string, unknown>) => SignedDataScope) => {
    const payload = await verifyAppleJws(jws, (await loadRoot()).certificate, now());
    const scope = readScope(payload);
    if (scope.bundleId !== options.bundleId) {
      throw new AppleSignedDataVerificationError('bundle_id_mismatch', 'Apple signed data is for another bundle ID');
    }
    const environment = readEnvironment(scope.environment);
    if (!environment) {
      throw new AppleSignedDataVerificationError(
        'environment_unsupported',
        'Apple signed data names neither the Production nor the Sandbox environment'
      );
    }
    return { payload, environment };
  };
  return {
    verifyNotification: (signedPayload) => verify(signedPayload, readNotificationScope),
    verifyTransaction: (signedTransaction) =>
      verify(signedTransaction, (payload) => ({ bundleId: payload.bundleId, environment: payload.environment }))
  };
}

/** Maps Apple's environment name by exact comparison, so inherited object keys never match. */
function readEnvironment(value: unknown): AppleEnvironment | undefined {
  if (value === 'Production') {
    return 'production';
  }
  if (value === 'Sandbox') {
    return 'sandbox';
  }
  return undefined;
}

interface SignedDataScope {
  bundleId: unknown;
  environment: unknown;
}

/**
 * The notification envelopes that carry the app's `bundleId` and `environment`: `data`, `summary` for a summary
 * notification, `appData` for RESCIND_CONSENT and `unclaimInfo` for UNCLAIM_SEATS. Apple sends exactly one of these or
 * `externalPurchaseToken`.
 */
const NOTIFICATION_SCOPE_ENVELOPES = ['data', 'summary', 'appData', 'unclaimInfo'] as const;

/** Reads the app a notification names from its envelope, or from `externalPurchaseToken`. */
function readNotificationScope(payload: Record<string, unknown>): SignedDataScope {
  for (const envelope of NOTIFICATION_SCOPE_ENVELOPES) {
    const scope = asRecord(payload[envelope]);
    if (scope) {
      return { bundleId: scope.bundleId, environment: scope.environment };
    }
  }
  const token = asRecord(payload.externalPurchaseToken);
  if (token) {
    const sandbox = typeof token.externalPurchaseId === 'string' && token.externalPurchaseId.startsWith('SANDBOX');
    return { bundleId: token.bundleId, environment: sandbox ? 'Sandbox' : 'Production' };
  }
  return { bundleId: undefined, environment: undefined };
}

/** Verifies the JWS's chain to `root` and its ES256 signature, then returns its payload. */
async function verifyAppleJws(jws: string, root: X509Certificate, at: Date): Promise<Record<string, unknown>> {
  if (typeof jws !== 'string') {
    throw new AppleSignedDataVerificationError('malformed', 'Apple signed data must be a compact JWS');
  }
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new AppleSignedDataVerificationError('malformed', 'Apple signed data must be a compact JWS');
  }
  const header = decodeJsonSegment(parts[0], 'header');
  const payload = decodeJsonSegment(parts[1], 'payload');
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(parts[2]);
  } catch {
    throw new AppleSignedDataVerificationError('malformed', 'Apple signed data signature is not base64url');
  }
  if (header.alg !== 'ES256') {
    throw new AppleSignedDataVerificationError('unsupported_algorithm', 'Apple signed data must be signed with ES256');
  }
  const leafKey = await verifyAppleCertificateChain(header.x5c, root, at);
  const valid = signature.length === 64 && (await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    leafKey,
    toArrayBuffer(signature),
    toArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  ));
  if (!valid) {
    throw new AppleSignedDataVerificationError('signature_invalid', 'Apple signed data signature does not verify');
  }
  return payload;
}

/**
 * Verifies an x5c chain (leaf, intermediate, root) and returns the leaf's ES256 key: the root is byte-identical to the
 * trusted root, each certificate is issued and signed by the next, the intermediate is a CA, the leaf and intermediate
 * carry Apple's OIDs, and all three are valid at `at`.
 */
export async function verifyAppleCertificateChain(x5c: unknown, root: X509Certificate, at: Date): Promise<CryptoKey> {
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((entry) => typeof entry === 'string')) {
    throw new AppleSignedDataVerificationError('malformed', 'Apple signed data must carry a three-certificate x5c chain');
  }
  let chain: X509Certificate[];
  try {
    chain = (x5c as string[]).map((entry) => parseCertificate(base64ToBytes(entry)));
  } catch {
    throw new AppleSignedDataVerificationError('malformed', 'Apple signed data x5c chain is not valid DER certificates');
  }
  const [leaf, intermediate, chainRoot] = chain;
  if (!bytesEqual(chainRoot.raw, root.raw)) {
    throw new AppleSignedDataVerificationError('untrusted_root', 'Apple signed data chain does not end at the trusted Apple root');
  }
  if (!intermediate.isCertificateAuthority || !(await issuedBy(intermediate, root)) || !(await issuedBy(leaf, intermediate))) {
    throw new AppleSignedDataVerificationError('invalid_chain', 'Apple signed data certificates do not chain to the trusted root');
  }
  if (!leaf.extensionOids.has(APPLE_SIGNING_LEAF_OID) || !intermediate.extensionOids.has(APPLE_WWDR_INTERMEDIATE_OID)) {
    throw new AppleSignedDataVerificationError('missing_apple_oid', 'Apple signed data certificates lack Apple\'s OIDs');
  }
  const time = at.getTime();
  if (chain.some((certificate) => time < certificate.notBefore.getTime() || time > certificate.notAfter.getTime())) {
    throw new AppleSignedDataVerificationError('certificate_expired', 'An Apple signed data certificate is not valid now');
  }
  if (leaf.namedCurve !== 'P-256') {
    throw new AppleSignedDataVerificationError('unsupported_algorithm', 'Apple signing certificate key is not P-256');
  }
  try {
    return await importCertificateKey(leaf);
  } catch {
    throw new AppleSignedDataVerificationError('malformed', 'Apple signing certificate key is not a valid P-256 point');
  }
}

/** Verifies an x5c chain against the bundled, pinned Apple root. Not exported from the package; the smoke test uses it. */
export async function verifyAppleCertificateChainToPinnedRoot(x5c: unknown, at: Date): Promise<CryptoKey> {
  return verifyAppleCertificateChain(x5c, (await loadPinnedAppleRoot()).certificate, at);
}

/** An issuer key WebCrypto cannot import is a broken chain, not a crash. */
async function issuedBy(certificate: X509Certificate, issuer: X509Certificate): Promise<boolean> {
  try {
    return await isIssuedBy(certificate, issuer);
  } catch {
    return false;
  }
}

function decodeJsonSegment(segment: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(segment)));
    const record = asRecord(value);
    if (record && !Array.isArray(value)) {
      return record;
    }
  } catch {
    // Falls through to the malformed error below.
  }
  throw new AppleSignedDataVerificationError('malformed', `Apple signed data ${what} is not a base64url JSON object`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
