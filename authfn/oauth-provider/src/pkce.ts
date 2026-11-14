import { createHash } from 'node:crypto';
import { secretsEqual } from './http.js';

// RFC 7636 4.1: code_verifier = 43*128unreserved.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
// BASE64URL(SHA256(verifier)) is always 43 characters without padding.
const S256_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function isS256Challenge(value: string): boolean {
  return S256_CHALLENGE.test(value);
}

/** RFC 7636 4.6: BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) == code_challenge. */
export function verifyS256(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier)) {
    return false;
  }
  return secretsEqual(createHash('sha256').update(verifier, 'ascii').digest('base64url'), challenge);
}
