/**
 * GitHub App private keys, imported with WebCrypto only.
 *
 * GitHub issues App keys as PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`), which
 * WebCrypto cannot import directly; PKCS#8 PEM (`BEGIN PRIVATE KEY`) is what
 * `openssl pkcs8 -topk8` produces. A PKCS#1 key is converted by wrapping its
 * DER in a PKCS#8 `PrivateKeyInfo` with the rsaEncryption algorithm.
 */

/** Thrown for a private key that cannot be read. Its message never quotes the key. */
export class GitHubAppKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppKeyError';
  }
}

const PEM_BLOCK = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END \1-----$/;

/** `AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }`. */
const RSA_ENCRYPTION_ALGORITHM = Uint8Array.of(
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
);
/** `version INTEGER 0`. */
const PKCS8_VERSION = Uint8Array.of(0x02, 0x01, 0x00);

export type GitHubAppKeyFormat = 'pkcs1' | 'pkcs8';

function decodeBase64(body: string): Uint8Array {
  const compact = body.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0) throw new GitHubAppKeyError('The GitHub App private key PEM body is not valid base64');
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new GitHubAppKeyError('The GitHub App private key PEM body is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** DER definite-length encoding. */
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derElement(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), derLength(content.length), content]);
}

/**
 * Wraps a PKCS#1 `RSAPrivateKey` DER in a PKCS#8 `PrivateKeyInfo`:
 * `SEQUENCE { INTEGER 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }`.
 */
export function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  if (pkcs1.length === 0 || pkcs1[0] !== 0x30) throw new GitHubAppKeyError('The PKCS#1 private key is not a DER SEQUENCE');
  return derElement(0x30, concat([PKCS8_VERSION, RSA_ENCRYPTION_ALGORITHM, derElement(0x04, pkcs1)]));
}

/** Reads a PKCS#1 or PKCS#8 PEM private key into PKCS#8 DER. */
export function pemToPkcs8(pem: string): { der: Uint8Array; format: GitHubAppKeyFormat } {
  if (typeof pem !== 'string') throw new GitHubAppKeyError('The GitHub App private key must be a PEM string');
  const match = PEM_BLOCK.exec(pem.trim());
  if (!match) {
    throw new GitHubAppKeyError('The GitHub App private key must be one PEM block: "BEGIN RSA PRIVATE KEY" (PKCS#1) or "BEGIN PRIVATE KEY" (PKCS#8)');
  }
  const der = decodeBase64(match[2]!);
  if (match[1] === 'RSA PRIVATE KEY') return { der: wrapPkcs1InPkcs8(der), format: 'pkcs1' };
  return { der, format: 'pkcs8' };
}

/** The runtime's WebCrypto key type, without depending on DOM type definitions. */
export type GitHubAppSigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export const GITHUB_APP_SIGNING_ALGORITHM = Object.freeze({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const);

/** Imports a PKCS#1 or PKCS#8 PEM RSA private key as a non-extractable RS256 signing key. */
export async function importGitHubAppPrivateKey(pem: string): Promise<GitHubAppSigningKey> {
  const { der } = pemToPkcs8(pem);
  try {
    return await crypto.subtle.importKey('pkcs8', der, GITHUB_APP_SIGNING_ALGORITHM, false, ['sign']);
  } catch {
    // The runtime's own message is not forwarded: it is not needed and could describe the key bytes.
    throw new GitHubAppKeyError('The GitHub App private key is not a valid RSA private key');
  }
}
