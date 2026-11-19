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
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] as number);
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

// Intrinsics captured when the module loads, so later changes to the globals cannot redirect the byte copies below.
const IntrinsicUint8Array = Uint8Array;
const isView = ArrayBuffer.isView;

type Getter = (this: unknown) => unknown;

function intrinsicGetter(prototype: object, name: PropertyKey): Getter {
  return Object.getOwnPropertyDescriptor(prototype, name)?.get as Getter;
}

const arrayBufferByteLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength');
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'function' ? intrinsicGetter(SharedArrayBuffer.prototype, 'byteLength') : undefined;

/** The byte length of an `ArrayBuffer` or `SharedArrayBuffer` from any realm, read by its internal slot; else undefined. */
function bufferByteLength(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const byteLength of [arrayBufferByteLength, sharedArrayBufferByteLength]) {
    if (!byteLength) continue;
    try {
      return byteLength.call(value) as number;
    } catch {
      // Not this kind of buffer.
    }
  }
  return undefined;
}

/** True for an `ArrayBuffer` or `SharedArrayBuffer` from any realm; a proxy or an object faking `Symbol.toStringTag` fails. */
export function isArrayBuffer(value: unknown): value is ArrayBufferLike {
  return bufferByteLength(value) !== undefined;
}

// The built-in accessors, called directly, so a view cannot redirect the copy through its own `buffer`, `byteOffset`
// or `byteLength` properties, and so a view from another realm is read by its internal slots.
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY = {
  buffer: intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'buffer'),
  byteOffset: intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'byteOffset'),
  byteLength: intrinsicGetter(TYPED_ARRAY_PROTOTYPE, 'byteLength'),
};
// `%TypedArray%.prototype[Symbol.toStringTag]` reads the [[TypedArrayName]] slot: the element type of a typed array
// from any realm, and `undefined` for anything else (including a proxy or a DataView).
const typedArrayName = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
// `%TypedArray%.prototype.values` throws for a detached or out-of-bounds typed array, where the getters above return 0.
const validateTypedArray = (TYPED_ARRAY_PROTOTYPE as { values: (this: unknown) => unknown }).values;
// The DataView `byteOffset` and `byteLength` getters themselves throw for a detached or out-of-bounds view.
const DATA_VIEW = {
  buffer: intrinsicGetter(DataView.prototype, 'buffer'),
  byteOffset: intrinsicGetter(DataView.prototype, 'byteOffset'),
  byteLength: intrinsicGetter(DataView.prototype, 'byteLength'),
};

/** True for a genuine `Uint8Array` (or subclass instance) from any realm. */
export function isUint8Array(value: unknown): value is Uint8Array {
  return isView(value) && typedArrayName.call(value) === 'Uint8Array';
}

/**
 * A fixed-length `Uint8Array` over the range the source covers at this moment. It never tracks the length of a
 * resizable or growable buffer, so the range a caller budgets and copies cannot grow afterwards.
 */
function fixedView(source: unknown): Uint8Array {
  const length = bufferByteLength(source);
  if (length !== undefined) return new IntrinsicUint8Array(source as ArrayBufferLike, 0, length);
  if (!isView(source)) throw new TypeError('not a buffer or view');
  const accessors = typedArrayName.call(source) === undefined ? DATA_VIEW : TYPED_ARRAY;
  if (accessors === TYPED_ARRAY) validateTypedArray.call(source);
  return new IntrinsicUint8Array(
    accessors.buffer.call(source) as ArrayBufferLike,
    accessors.byteOffset.call(source) as number,
    accessors.byteLength.call(source) as number,
  );
}

/** Why `copyBytes` produced no copy: the source is detached or out of bounds, or longer than the limit. */
export type ByteCopyFailure = 'unreadable' | 'too-large';

/**
 * Copies the bytes of an `ArrayBuffer`, `SharedArrayBuffer` or `ArrayBufferView` (from any realm) into a fresh
 * `Uint8Array` over its own, non-shared `ArrayBuffer`, as WebCrypto requires. The source range is observed once, as
 * a fixed-length view, and checked against `maxLength` before anything is allocated. Returns `'unreadable'` when the
 * buffer is detached or the view is out of bounds of a shrunk resizable buffer, so callers report it with their own
 * error code instead of signing an empty range, and `'too-large'` when the range exceeds `maxLength`.
 */
export function copyBytes(
  source: ArrayBufferLike | ArrayBufferView,
  maxLength = Number.POSITIVE_INFINITY,
): Uint8Array<ArrayBuffer> | ByteCopyFailure {
  try {
    const view = fixedView(source);
    if (view.byteLength > maxLength) return 'too-large';
    const copy = new IntrinsicUint8Array(view.byteLength);
    copy.set(view);
    return copy;
  } catch {
    return 'unreadable';
  }
}
