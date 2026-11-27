import { invalidRequest } from '../errors.js';

/** Longest file name accepted at upload init, in UTF-16 code units. */
export const MAX_FILE_NAME_LENGTH = 255;
/** Longest MIME type (with parameters) accepted at upload init. */
export const MAX_MIME_TYPE_LENGTH = 1024;
/** Longest idempotency key accepted at upload init. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
/** Largest `metadata` object accepted at upload init, measured as UTF-8 JSON. */
export const MAX_METADATA_BYTES = 16 * 1024;

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// A UTF-16 surrogate without its partner: valid in JSON, but not text a
// database or storage provider can store.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Metadata text: no lone surrogate, and no NUL, which PostgreSQL jsonb refuses.
const isBadMetadataText = (text: string): boolean => LONE_SURROGATE.test(text) || text.includes(String.fromCharCode(0));

/** A JSON.rawJSON wrapper (newer runtimes): it always stands for a JSON primitive. */
function isRawJsonValue(value: unknown): boolean {
  const isRawJSON = (JSON as { isRawJSON?: (v: unknown) => boolean }).isRawJSON;
  return typeof isRawJSON === 'function' && isRawJSON(value);
}

/** Deepest metadata nesting accepted; deeper metadata is refused. */
export const MAX_METADATA_DEPTH = 32;

/**
 * Most values (objects, arrays, keys and leaves) the metadata walk visits. A
 * JSON object within MAX_METADATA_BYTES has far fewer; the budget stops a
 * structure that reuses one child many times (whose serialization would
 * explode) before it is expanded.
 */
const MAX_METADATA_NODES = MAX_METADATA_BYTES;

// Thrown for a budget failure and recognised by identity, never by inspecting
// a value a caller's hook threw.
const METADATA_BUDGET_EXCEEDED: unique symbol = Symbol('metadata budget exceeded');

function hasSlot(intrinsic: (this: unknown) => unknown, value: object): boolean {
  try {
    intrinsic.call(value);
    return true;
  } catch {
    return false;
  }
}

function charge(budget: { bytes: number }, bytes: number): void {
  budget.bytes -= bytes;
  if (budget.bytes < 0) throw METADATA_BUDGET_EXCEEDED;
}

/**
 * The plain JSON value JSON.stringify would write for `value`: `toJSON` is
 * applied (with the property key), non-finite numbers become null, and
 * undefined, functions and symbols are dropped from objects (null in arrays).
 * Throws past MAX_METADATA_DEPTH or the node budget, before expanding a
 * structure that reuses children, and on BigInt.
 */
interface Normalized {
  value: unknown;
  /** The JSON text JSON.stringify would write, in the original property order; undefined when dropped. */
  json: string | undefined;
}

function normalizeJson(
  value: unknown,
  key: string,
  depth: number,
  budget: { left: number; bytes: number },
  ancestors: Set<object> = new Set(),
): Normalized {
  budget.left -= 1;
  if (budget.left < 0 || depth > MAX_METADATA_DEPTH) throw METADATA_BUDGET_EXCEEDED;
  if (value !== null && (typeof value === 'object' || typeof value === 'bigint' || typeof value === 'function')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = Reflect.apply(toJSON, value, [key]);
  }
  // Boxed primitives serialize as their primitive value, as in JSON.stringify,
  // detected by their internal slots (so wrappers from another realm count):
  // Number and String are converted with ToNumber/ToString, Boolean read with
  // the intrinsic valueOf.
  if (value !== null && typeof value === 'object') {
    // Unary plus is ToNumber (a BigInt from toPrimitive throws, as in JSON.stringify).
    if (hasSlot(Number.prototype.valueOf, value)) value = +(value as unknown as number);
    else if (hasSlot(String.prototype.valueOf, value)) value = String(value);
    else if (hasSlot(Boolean.prototype.valueOf, value)) value = Boolean.prototype.valueOf.call(value);
    // A boxed BigInt is rejected, as JSON.stringify rejects a BigInt.
    else if (hasSlot(BigInt.prototype.valueOf, value)) throw new TypeError('BigInt is not JSON');
  }
  if (typeof value === 'string') {
    // Count every occurrence at its escaped UTF-8 size, so repeated
    // references to one long string cannot outgrow the byte limit unseen.
    if (value.length > MAX_METADATA_BYTES) charge(budget, MAX_METADATA_BYTES + 1);
    const json = JSON.stringify(value);
    charge(budget, new TextEncoder().encode(json).byteLength);
    return { value, json };
  }
  if (value === null || typeof value === 'boolean') {
    charge(budget, 5);
    return { value, json: JSON.stringify(value) };
  }
  if (typeof value === 'number') {
    const json = JSON.stringify(value);
    charge(budget, json.length);
    return { value: Number.isFinite(value) ? value : null, json };
  }
  if (typeof value === 'bigint') throw new TypeError('BigInt is not JSON');
  if (typeof value !== 'object') return { value: undefined, json: undefined };
  // JSON.rawJSON values (newer runtimes) are kept as they are, so both the
  // fingerprint and the stored JSON carry the raw text exactly (a number past
  // 2^53 isn't rounded); the decoded value is what gets validated.
  if (isRawJsonValue(value)) {
    const raw = String((value as { rawJSON: unknown }).rawJSON);
    charge(budget, raw.length);
    const decoded: unknown = JSON.parse(raw);
    if (typeof decoded === 'string' && isBadMetadataText(decoded)) throw new TypeError('metadata text is not well formed');
    return { value, json: raw };
  }
  // A value that is its own ancestor is circular, which JSON.stringify refuses.
  if (ancestors.has(value)) throw new TypeError('circular metadata');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      const parts: string[] = [];
      // ToLength of the length, read once, as JSON.stringify does.
      // Unary plus is ToNumber: a BigInt length throws, as in JSON.stringify.
      const rawLength = Math.trunc(+((value as { length: unknown }).length as number));
      const length = Number.isFinite(rawLength) ? Math.min(Math.max(rawLength, 0), Number.MAX_SAFE_INTEGER) : rawLength > 0 ? Number.MAX_SAFE_INTEGER : 0;
      for (let i = 0; i < length; i++) {
        const item = normalizeJson((value as unknown[])[i], String(i), depth + 1, budget, ancestors);
        charge(budget, 1);
        out.push(item.value === undefined ? null : item.value);
        parts.push(item.json ?? 'null');
      }
      return { value: out, json: `[${parts.join(',')}]` };
    }
    const out: Record<string, unknown> = {};
    const parts: string[] = [];
    for (const name of Object.keys(value)) {
      budget.left -= 1;
      if (budget.left < 0) throw METADATA_BUDGET_EXCEEDED;
      const item = normalizeJson((value as Record<string, unknown>)[name], name, depth + 1, budget, ancestors);
      if (item.json !== undefined) {
        const keyJson = JSON.stringify(name);
        charge(budget, new TextEncoder().encode(keyJson).byteLength + 2);
        Object.defineProperty(out, name, { value: item.value, enumerable: true, writable: true, configurable: true });
        parts.push(`${keyJson}:${item.json}`);
      }
    }
    return { value: out, json: `{${parts.join(',')}}` };
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Whether the value holds a lone surrogate or NUL, nests deeper than
 * MAX_METADATA_DEPTH, or has more than MAX_METADATA_NODES values (all refused).
 */
function hasLoneSurrogate(value: unknown, depth = 0, budget = { left: MAX_METADATA_NODES }): boolean {
  budget.left -= 1;
  if (budget.left < 0) return true;
  if (typeof value === 'string') return isBadMetadataText(value);
  // A raw JSON primitive's decoded text was checked when it was normalized.
  if (value === null || typeof value !== 'object' || isRawJsonValue(value)) return false;
  if (depth >= MAX_METADATA_DEPTH) return true;
  // Plain loops and Object.keys only: no method of the value itself is called.
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (hasLoneSurrogate(value[i], depth + 1, budget)) return true;
    }
    return false;
  }
  for (const key of Object.keys(value)) {
    budget.left -= 1;
    if (budget.left < 0 || isBadMetadataText(key) || hasLoneSurrogate((value as Record<string, unknown>)[key], depth + 1, budget)) return true;
  }
  return false;
}

// type "/" subtype, each an HTTP token (RFC 9110), plus optional parameters.
// Which types are allowed is the policy's decision, not this syntax check's.
// Each parameter is `token=token` or `token=quoted-string` (quoted text and
// quoted pairs: tab, visible ASCII and Latin-1 obs-text); empty parameter
// slots are allowed. Nothing above U+00FF, which no HTTP header can carry.
/** Strips leading and trailing spaces and tabs (HTTP whitespace) in linear time. */
function trimHttpWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start++;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end--;
  return value.slice(start, end);
}

const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MIME_QUOTED = '"(?:[\\t \\x21\\x23-\\x5B\\x5D-\\x7E\\x80-\\xFF]|\\\\[\\t \\x21-\\x7E\\x80-\\xFF])*"';
const MIME_TYPE = new RegExp(
  `^${MIME_TOKEN}/${MIME_TOKEN}(?:[ \\t]*;(?:[ \\t]*${MIME_TOKEN}=(?:${MIME_TOKEN}|${MIME_QUOTED}))?)*[ \\t]*$`,
);

/**
 * Checks a client-supplied file name. A name is shown to people and kept in the
 * `files` row; it may not carry path separators, control characters or a bare
 * `.`/`..`, so it can never move a storage key into another directory.
 */
export function assertValidFileName(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw invalidRequest('fileName must be a string', { field: 'fileName' });
  }
  if (value.trim().length === 0) {
    throw invalidRequest('fileName must not be empty', { field: 'fileName' });
  }
  if (value.length > MAX_FILE_NAME_LENGTH) {
    throw invalidRequest(`fileName must be at most ${MAX_FILE_NAME_LENGTH} characters`, {
      field: 'fileName',
      maxLength: MAX_FILE_NAME_LENGTH,
    });
  }
  if (value.includes('/') || value.includes('\\')) {
    throw invalidRequest('fileName must not contain path separators', { field: 'fileName' });
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw invalidRequest('fileName must not contain control characters', { field: 'fileName' });
  }
  if (value === '.' || value === '..') {
    throw invalidRequest('fileName must not be a dot segment', { field: 'fileName' });
  }
  if (LONE_SURROGATE.test(value)) {
    throw invalidRequest('fileName must be well-formed Unicode', { field: 'fileName' });
  }
}

export interface UploadInitInput {
  policy: unknown;
  fileName: unknown;
  size: unknown;
  mimeType: unknown;
  metadata?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Validates an upload init body against the published contract
 * (`CreateUploadSessionRequest`). Throws `FILEFN_INVALID_REQUEST` (400) on the
 * first field that does not conform.
 */
/**
 * `options.fingerprinted`: whether this request's idempotency key will be used
 * (the service skips it for anonymous callers). Only then is metadata
 * normalized under the fingerprint's key `md`; otherwise under the root key.
 */
export function assertValidUploadInit(
  input: UploadInitInput,
  options: { fingerprinted?: boolean } = {},
): { metadata?: Record<string, unknown>; metadataJson?: string } {
  // No length cap: the name must match a registered policy anyway.
  if (typeof input.policy !== 'string' || input.policy.length === 0 || LONE_SURROGATE.test(input.policy)) {
    throw invalidRequest('policy must be a non-empty string', { field: 'policy' });
  }

  assertValidFileName(input.fileName);

  if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 0) {
    throw invalidRequest('size must be a non-negative integer number of bytes', { field: 'size' });
  }

  if (typeof input.mimeType === 'string' && input.mimeType.length > MAX_MIME_TYPE_LENGTH) {
    throw invalidRequest(`mimeType must be at most ${MAX_MIME_TYPE_LENGTH} characters`, {
      field: 'mimeType',
      maxLength: MAX_MIME_TYPE_LENGTH,
    });
  }
  if (
    typeof input.mimeType !== 'string' ||
    // Leading and trailing spaces or tabs are HTTP whitespace, not part of the type.
    !MIME_TYPE.test(trimHttpWhitespace(input.mimeType)) ||
    // Tab is HTTP whitespace and may separate parameters; other controls may not.
    // C0 controls other than tab, and DEL; U+0080-U+00FF is left to the
    // quoted-string grammar (obs-text).
    /[\u0000-\u0008\u000a-\u001f\u007f]/.test(input.mimeType) ||
    LONE_SURROGATE.test(input.mimeType)
  ) {
    throw invalidRequest('mimeType must be a MIME type such as "image/png"', { field: 'mimeType' });
  }

  let snapshot: Record<string, unknown> | undefined;
  let snapshotJson: string | undefined;
  // Omitted metadata is fine; an explicit null is not an object.
  if (input.metadata !== undefined) {
    // Normalized once, as JSON.stringify would (toJSON applied with the key
    // `md`, which the request fingerprint has always serialized it under, when
    // there is a fingerprint; with the root key '' otherwise), within
    // depth and node budgets; the plain result is what gets checked, hashed
    // and stored.
    let normalized: unknown;
    let normalizedJson: string | undefined;
    let overBytes = false;
    try {
      // The byte budget has headroom over the limit; the exact size is
      // checked on the final string below.
      const result = normalizeJson(input.metadata, input.idempotencyKey && options.fingerprinted !== false ? 'md' : '', 0, { left: MAX_METADATA_NODES, bytes: MAX_METADATA_BYTES * 2 });
      normalized = result.value;
      normalizedJson = result.json;
    } catch (error) {
      overBytes = error === METADATA_BUDGET_EXCEEDED;
      normalized = undefined;
    }
    if (overBytes) {
      throw invalidRequest(`metadata must be at most ${MAX_METADATA_BYTES} bytes as JSON, nested at most ${MAX_METADATA_DEPTH} levels`, {
        field: 'metadata',
        maxBytes: MAX_METADATA_BYTES,
      });
    }
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized) || isRawJsonValue(normalized) || hasLoneSurrogate(normalized)) {
      throw invalidRequest(`metadata must be a JSON object of well-formed text, nested at most ${MAX_METADATA_DEPTH} levels`, { field: 'metadata' });
    }
    const encoded = normalizedJson ?? JSON.stringify(normalized);
    if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
      throw invalidRequest(`metadata must be at most ${MAX_METADATA_BYTES} bytes as JSON`, {
        field: 'metadata',
        maxBytes: MAX_METADATA_BYTES,
      });
    }
    snapshot = normalized as Record<string, unknown>;
    snapshotJson = encoded;
  }

  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    if (
      typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      CONTROL_CHARACTERS.test(input.idempotencyKey) ||
      LONE_SURROGATE.test(input.idempotencyKey)
    ) {
      throw invalidRequest(`idempotency key must be a string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, {
        field: 'idempotencyKey',
      });
    }
  }

  // metadataJson is the JSON text in the caller's property order, for the
  // request fingerprint; metadata is the plain copy that is stored.
  return snapshot === undefined ? {} : { metadata: snapshot, metadataJson: snapshotJson };
}
