// Keys are generated per run with WebCrypto; no key material is committed.
import { createSigningKeyRing, createWebCryptoSigner, type Es256Signer, type KeyStatus, type SigningKeyRing } from '@secfn/keys';

export const ISSUER = 'https://issuer.example.test/tenant-1';

export async function generateSigner(): Promise<Es256Signer> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return createWebCryptoSigner({ privateJwk });
}

export function ring(entries: ReadonlyArray<readonly [kid: string, status: KeyStatus, signer: Es256Signer]>): SigningKeyRing {
  return createSigningKeyRing({
    keys: entries.map(([kid, status, signer]) => (status === 'retired' ? { kid, alg: 'ES256', status } : { kid, alg: 'ES256', status, signer })),
  });
}

export function get(url: string, method = 'GET'): Request {
  return new Request(url, { method });
}
