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

/** Deepest metadata nesting accepted; deeper metadata is refused. */
export const MAX_METADATA_DEPTH = 32;

/** Whether the value holds a lone surrogate, or nests deeper than MAX_METADATA_DEPTH (also refused). */
function hasLoneSurrogate(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (depth >= MAX_METADATA_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => hasLoneSurrogate(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => LONE_SURROGATE.test(key) || hasLoneSurrogate(item, depth + 1),
  );
}

// type "/" subtype, each an HTTP token (RFC 9110), plus optional parameters.
// Which types are allowed is the policy's decision, not this syntax check's.
const MIME_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+([ \t]*;.*)?$/;

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
export function assertValidUploadInit(input: UploadInitInput): void {
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
    !MIME_TYPE.test(input.mimeType.replace(/^[ \t]+|[ \t]+$/g, '')) ||
    // Tab is HTTP whitespace and may separate parameters; other controls may not.
    CONTROL_CHARACTERS.test(input.mimeType.replace(/\t/g, ' ')) ||
    LONE_SURROGATE.test(input.mimeType)
  ) {
    throw invalidRequest('mimeType must be a MIME type such as "image/png"', { field: 'mimeType' });
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    if (typeof input.metadata !== 'object' || Array.isArray(input.metadata) || hasLoneSurrogate(input.metadata)) {
      throw invalidRequest(`metadata must be a JSON object of well-formed text, nested at most ${MAX_METADATA_DEPTH} levels`, { field: 'metadata' });
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(input.metadata);
    } catch {
      throw invalidRequest('metadata must be a JSON object', { field: 'metadata' });
    }
    if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
      throw invalidRequest(`metadata must be at most ${MAX_METADATA_BYTES} bytes as JSON`, {
        field: 'metadata',
        maxBytes: MAX_METADATA_BYTES,
      });
    }
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
}
