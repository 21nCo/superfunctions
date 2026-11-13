import { randomFillSync } from 'crypto';

/** Prefixes of the opaque identifiers FileFn generates. */
export type FileFnIdPrefix = 'upl' | 'file' | 'ver' | 'art';

/** Crockford base32, lowercase: 32 symbols, so `byte & 31` maps uniformly. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RANDOM_LENGTH = 20;

/**
 * Generates an opaque `<prefix>_<random>` identifier from the `crypto` module's
 * CSPRNG (`randomFillSync`). It does not depend on a global Web Crypto object,
 * so it works on Node 18 (where `globalThis.crypto` is absent by default), Bun,
 * Deno and Workers with `nodejs_compat`, the same requirement as FileFn's
 * other `crypto` imports.
 *
 * The random part is 20 base32 characters (100 bits). The whole ID stays under
 * 32 characters, the length FileFn's log redactor treats as a secret, so IDs
 * stay readable in logs and events. IDs are opaque: IDs issued by earlier
 * versions (`<prefix>_<time36>_<random36>`) stay valid.
 */
export function generateFileFnId(prefix: FileFnIdPrefix): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  randomFillSync(bytes);
  let random = '';
  for (const byte of bytes) {
    random += ALPHABET[byte & 31];
  }
  return `${prefix}_${random}`;
}
