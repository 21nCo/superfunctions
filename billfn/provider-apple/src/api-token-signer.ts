/**
 * Signs App Store Server API bearer tokens (ES256 JWTs) with an App Store Connect in-app purchase key on WebCrypto, so
 * it runs on Workers. A token is reused until shortly before it expires.
 */
import { base64ToBytes, bytesToBase64Url, toArrayBuffer, utf8ToBase64Url } from './encoding.js';

/** Apple rejects a token that expires more than 60 minutes after it was issued. */
const MAX_TTL_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 1200;
/** A cached token is replaced once it has less than this left, so a request never carries an expiring token. */
const REFRESH_MARGIN_SECONDS = 60;

export interface AppStoreServerApiKey {
  /** The App Store Connect issuer ID. */
  issuerId: string;
  /** The in-app purchase key's ID. */
  keyId: string;
  /** The in-app purchase key (the downloaded .p8 file): a PKCS#8 PEM ES256 private key. */
  privateKey: string;
}

export interface AppStoreServerApiTokenSignerOptions extends AppStoreServerApiKey {
  /** The app's bundle ID, which the token claims as `bid`. */
  bundleId: string;
  /** Token lifetime in seconds, at most 3600. Defaults to 1200. */
  ttlSeconds?: number;
  /** The clock tokens are issued by, in milliseconds. Defaults to Date.now. */
  now?: () => number;
}

/** Returns a token provider that signs App Store Server API tokens with the key, reusing each until it nearly expires. */
export function createAppStoreServerApiTokenSigner(options: AppStoreServerApiTokenSignerOptions): () => Promise<string> {
  for (const field of ['issuerId', 'keyId', 'bundleId'] as const) {
    if (typeof options[field] !== 'string' || options[field].trim().length === 0) {
      throw new TypeError(`The App Store Server API token signer requires ${field}`);
    }
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new TypeError(`The App Store Server API token lifetime must be a whole number of seconds from 1 to ${MAX_TTL_SECONDS}`);
  }
  const keyBytes = readPkcs8Pem(options.privateKey);
  const now = options.now ?? Date.now;
  const refreshMargin = Math.min(REFRESH_MARGIN_SECONDS, Math.floor(ttlSeconds / 2));
  const header = utf8ToBase64Url(JSON.stringify({ alg: 'ES256', kid: options.keyId, typ: 'JWT' }));

  let key: Promise<CryptoKey> | undefined;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const importKey = () => {
    key ??= crypto.subtle
      .importKey('pkcs8', toArrayBuffer(keyBytes), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
      .catch((error: unknown) => {
        key = undefined;
        throw new TypeError('The App Store Server API private key is not a PKCS#8 P-256 key', { cause: error });
      });
    return key;
  };

  const sign = async () => {
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = issuedAt + ttlSeconds;
    const payload = utf8ToBase64Url(
      JSON.stringify({ iss: options.issuerId, iat: issuedAt, exp: expiresAt, aud: 'appstoreconnect-v1', bid: options.bundleId })
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importKey(),
      toArrayBuffer(new TextEncoder().encode(`${header}.${payload}`))
    );
    const token = `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
    cached = { token, expiresAt };
    return token;
  };

  return async () => {
    const nowSeconds = Math.floor(now() / 1000);
    if (cached && cached.expiresAt - nowSeconds > refreshMargin) {
      return cached.token;
    }
    pending ??= sign().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Reads the DER body of a PKCS#8 PEM (`BEGIN PRIVATE KEY`), the format App Store Connect issues keys in. */
function readPkcs8Pem(pem: string): Uint8Array {
  if (typeof pem !== 'string') {
    throw new TypeError('The App Store Server API private key must be a PKCS#8 PEM string');
  }
  const match = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) {
    throw new TypeError('The App Store Server API private key must be a PKCS#8 PEM (BEGIN PRIVATE KEY)');
  }
  try {
    return base64ToBytes(match[1].replace(/\s+/g, ''));
  } catch {
    throw new TypeError('The App Store Server API private key PEM body is not base64');
  }
}
