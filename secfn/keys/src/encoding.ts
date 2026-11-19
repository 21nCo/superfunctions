const BASE64URL = /^[A-Za-z0-9_-]*$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  // TextEncoder always returns a view over a fresh, non-shared ArrayBuffer.
  return textEncoder.encode(value) as Uint8Array<ArrayBuffer>;
}

/** Decodes UTF-8, returning `undefined` for invalid byte sequences instead of substituting U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string | undefined {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Unpadded base64url (RFC 7515 §2). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Strict unpadded base64url decoding: rejects padding, characters outside the URL-safe alphabet and non-canonical
 * encodings (unused trailing bits set), so one byte string has exactly one accepted encoding.
 */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return base64UrlEncode(bytes) === value ? bytes : undefined;
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
    : undefined;

/** True for an `ArrayBuffer` or `SharedArrayBuffer` from any realm; a proxy or an object faking `Symbol.toStringTag` fails. */
export function isArrayBuffer(value: unknown): value is ArrayBufferLike {
  if (typeof value !== 'object' || value === null) return false;
  for (const byteLength of [arrayBufferByteLength, sharedArrayBufferByteLength]) {
    if (!byteLength) continue;
    try {
      byteLength.call(value);
      return true;
    } catch {
      // Not this kind of buffer.
    }
  }
  return false;
}

/**
 * Copies the bytes of an `ArrayBuffer`, `SharedArrayBuffer` or `ArrayBufferView` (from any realm) into a fresh
 * `Uint8Array` over its own, non-shared `ArrayBuffer`, as WebCrypto requires. Returns `undefined` when the buffer is
 * detached, so callers can report it with their own error code.
 */
export function copyBytes(source: ArrayBufferLike | ArrayBufferView): Uint8Array<ArrayBuffer> | undefined {
  let view: Uint8Array;
  try {
    // Constructing a view over a detached buffer throws, even for an empty range.
    view = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);
  } catch {
    return undefined;
  }
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}
