/**
 * Independently reviewed and pinned registry trust root: the public half of the AWS KMS Ed25519 release-signing
 * key. The private key never leaves KMS. Key rotation requires a code review and a new package version.
 */
export const REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGa6icVJn0LA8R37YtDVO0ncEc2MaFaM04Fihsu6VgZY=\n-----END PUBLIC KEY-----\n";

/** Registry key id of the pinned trust root: the first 24 hex characters of SHA-256 over its SPKI DER. */
export const REGISTRY_TRUST_ROOT_KEY_ID = 'a72cc93c0e85e7af79cf582c';
