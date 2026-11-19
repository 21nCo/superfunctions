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

type Getter = (this: unknown) => unknown;

function intrinsicGetter(prototype: object, name: string): Getter {
  return Object.getOwnPropertyDescriptor(prototype, name)?.get as Getter;
}

// The built-in accessors, called directly, so a view cannot redirect the copy through its own `buffer`, `byteOffset`
// or `byteLength` properties, and so a view from another realm is read by its internal slots.
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY = {
  buffer: intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'buffer'),
  byteOffset: intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'byteOffset'),
  byteLength: intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'byteLength'),
};
// `%TypedArray%.prototype.values` throws for a detached or out-of-bounds typed array, where the getters above return 0.
const validateTypedArray = (TYPED_ARRAY_PROTOTYPE as { values: (this: unknown) => unknown }).values;
// The DataView `byteOffset` and `byteLength` getters themselves throw for a detached or out-of-bounds view.
const DATA_VIEW = {
  buffer: intrinsicGetter(DataView.prototype, 'buffer'),
  byteOffset: intrinsicGetter(DataView.prototype, 'byteOffset'),
  byteLength: intrinsicGetter(DataView.prototype, 'byteLength'),
};

function viewOf(source: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (!ArrayBuffer.isView(source)) return new Uint8Array(source);
  let accessors = TYPED_ARRAY;
  try {
    TYPED_ARRAY.buffer.call(source);
  } catch {
    accessors = DATA_VIEW;
  }
  if (accessors === TYPED_ARRAY) validateTypedArray.call(source);
  return new Uint8Array(
    accessors.buffer.call(source) as ArrayBufferLike,
    accessors.byteOffset.call(source) as number,
    accessors.byteLength.call(source) as number,
  );
}

/**
 * Copies the bytes of an `ArrayBuffer`, `SharedArrayBuffer` or `ArrayBufferView` (from any realm) into a fresh
 * `Uint8Array` over its own, non-shared `ArrayBuffer`, as WebCrypto requires. Returns `undefined` when the buffer is
 * detached or the view is out of bounds of a shrunk resizable buffer, so callers report it with their own error code
 * instead of signing an empty range.
 */
export function copyBytes(source: ArrayBufferLike | ArrayBufferView): Uint8Array<ArrayBuffer> | undefined {
  let view: Uint8Array;
  try {
    view = viewOf(source);
  } catch {
    return undefined;
  }
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}
