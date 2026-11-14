import * as errors from '../errors.js';

/**
 * Grammar for a file ID a client supplies on `upload/init`: `file_` followed by
 * 8 to 64 characters from `[A-Za-z0-9_-]`. IDs FileFn generates
 * (`file_<20 base32 chars>`, and the legacy `file_<time36>_<random36>`) and IDs
 * `@filefn/client`'s `generateFileId()` produces match it, so an offline
 * capture can keep the same ID before and after it syncs.
 */
export const CLIENT_FILE_ID_PATTERN = /^file_[A-Za-z0-9_-]{8,64}$/;

/** Whether `value` is a file ID a client may supply on `upload/init`. */
export function isValidClientFileId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_FILE_ID_PATTERN.test(value);
}

/**
 * Returns the client-chosen file ID from an `upload/init` body, or `undefined`
 * when the body has none (`fileId` absent or `null`). Any other value outside
 * the grammar, including an empty string or a non-string, throws
 * `FILEFN_INVALID_FILE_ID` (400) before any lookup, so a malformed ID never
 * reaches storage keys or the authorizer.
 */
export function parseClientFileId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isValidClientFileId(value)) {
    throw errors.invalidFileId();
  }
  return value;
}
