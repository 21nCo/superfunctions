export class FileFnError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FileFnError';
  }

  get statusCode(): number {
    return this.status;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export const ErrorCodes = {
  AUTH_REQUIRED: 'FILEFN_AUTH_REQUIRED',
  FORBIDDEN: 'FILEFN_FORBIDDEN',
  NOT_FOUND: 'FILEFN_NOT_FOUND',
  POLICY_CONTENT_TYPE_NOT_ALLOWED: 'FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED',
  POLICY_MAX_SIZE_EXCEEDED: 'FILEFN_POLICY_MAX_SIZE_EXCEEDED',
  POLICY_NOT_FOUND: 'FILEFN_POLICY_NOT_FOUND',
  QUOTA_EXCEEDED: 'FILEFN_QUOTA_EXCEEDED',
  RATE_LIMITED: 'FILEFN_RATE_LIMITED',
  INVALID_PART_NUMBER: 'FILEFN_INVALID_PART_NUMBER',
  INVALID_ETAG: 'FILEFN_INVALID_ETAG',
  UPLOAD_INCOMPLETE: 'FILEFN_UPLOAD_INCOMPLETE',
  UPLOAD_EXPIRED: 'FILEFN_UPLOAD_EXPIRED',
  UPLOAD_ABORTED: 'FILEFN_UPLOAD_ABORTED',
  UPLOAD_ALREADY_COMPLETED: 'FILEFN_UPLOAD_ALREADY_COMPLETED',
  IDEMPOTENCY_CONFLICT: 'FILEFN_IDEMPOTENCY_CONFLICT',
  REPLAY_SCOPE_MISMATCH: 'FILEFN_REPLAY_SCOPE_MISMATCH',
  PART_CONFLICT: 'FILEFN_PART_CONFLICT',
  UPLOAD_SIZE_MISMATCH: 'FILEFN_UPLOAD_SIZE_MISMATCH',
  PART_TOO_LARGE: 'FILEFN_PART_TOO_LARGE',
  NO_SUPPORTED_UPLOAD_MODE: 'FILEFN_NO_SUPPORTED_UPLOAD_MODE',
  OFFLINE_UNSUPPORTED: 'FILEFN_OFFLINE_UNSUPPORTED',
  SESSION_NOT_FOUND: 'FILEFN_SESSION_NOT_FOUND',
  SHARE_EXPIRED: 'FILEFN_SHARE_EXPIRED',
  SHARE_REVOKED: 'FILEFN_SHARE_REVOKED',
  SHARE_DOWNLOADS_EXCEEDED: 'FILEFN_SHARE_DOWNLOADS_EXCEEDED',
  SHARE_NOT_FOUND: 'FILEFN_SHARE_NOT_FOUND',
  SHARE_DOWNLOAD_CONFLICT: 'FILEFN_SHARE_DOWNLOAD_CONFLICT',
  PERMISSION_NOT_FOUND: 'FILEFN_PERMISSION_NOT_FOUND',
  PROCESSING_ENQUEUE_FAILED: 'FILEFN_PROCESSING_ENQUEUE_FAILED',
  INVALID_RENDER_INTENT: 'FILEFN_INVALID_RENDER_INTENT',
  SESSION_TOKEN_REQUIRED: 'FILEFN_SESSION_TOKEN_REQUIRED',
  SESSION_TOKEN_INVALID: 'FILEFN_SESSION_TOKEN_INVALID',
  STORAGE_PATH_NOT_PER_VERSION: 'FILEFN_STORAGE_PATH_NOT_PER_VERSION',
  INVALID_FILE_ID: 'FILEFN_INVALID_FILE_ID',
  UPLOAD_COMPLETION_IN_PROGRESS: 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS',
  INVALID_REQUEST: 'FILEFN_INVALID_REQUEST',
  UNSUPPORTED_MEDIA_TYPE: 'FILEFN_UNSUPPORTED_MEDIA_TYPE',
  BODY_TOO_LARGE: 'FILEFN_BODY_TOO_LARGE',
  ARTIFACT_KIND_NOT_ALLOWED: 'FILEFN_ARTIFACT_KIND_NOT_ALLOWED',
  ARTIFACT_TYPE_NOT_ALLOWED: 'FILEFN_ARTIFACT_TYPE_NOT_ALLOWED',
  ARTIFACT_TOO_LARGE: 'FILEFN_ARTIFACT_TOO_LARGE',
  ARTIFACT_WRITE_CONFLICT: 'FILEFN_ARTIFACT_WRITE_CONFLICT',
  STORAGE_UPLOAD_UNSUPPORTED: 'FILEFN_STORAGE_UPLOAD_UNSUPPORTED',
  STORAGE_STAT_UNAVAILABLE: 'FILEFN_STORAGE_STAT_UNAVAILABLE',
  IMPORT_OBJECT_NOT_FOUND: 'FILEFN_IMPORT_OBJECT_NOT_FOUND',
  IMPORT_SIZE_MISMATCH: 'FILEFN_IMPORT_SIZE_MISMATCH',
  IMPORT_CONFLICT: 'FILEFN_IMPORT_CONFLICT',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export function authRequired(): FileFnError {
  return new FileFnError(ErrorCodes.AUTH_REQUIRED, 'Authentication required', 401);
}

export function forbidden(details?: Record<string, unknown>): FileFnError {
  return new FileFnError(ErrorCodes.FORBIDDEN, 'Access denied', 403, details);
}

export function notFound(resource: string): FileFnError {
  return new FileFnError(ErrorCodes.NOT_FOUND, `${resource} not found`, 404);
}

export function policyContentTypeNotAllowed(policy: string, mimeType: string): FileFnError {
  return new FileFnError(
    ErrorCodes.POLICY_CONTENT_TYPE_NOT_ALLOWED,
    'Content type not allowed',
    400,
    { policy, mimeType }
  );
}

export function policyMaxSizeExceeded(policy: string, maxSizeBytes: number, size: number): FileFnError {
  return new FileFnError(
    ErrorCodes.POLICY_MAX_SIZE_EXCEEDED,
    'File size exceeds policy max',
    400,
    { policy, maxSizeBytes, size }
  );
}

export function policyNotFound(policy: string): FileFnError {
  return new FileFnError(ErrorCodes.POLICY_NOT_FOUND, `Policy '${policy}' not found`, 400, { policy });
}

export function quotaExceeded(current: number, limit: number, requested: number): FileFnError {
  return new FileFnError(
    ErrorCodes.QUOTA_EXCEEDED,
    'Storage quota exceeded',
    402,
    { current, limit, requested }
  );
}

/** Quota refused for an account that isn't the caller's (a file owner's): no usage figures. */
export function ownerQuotaExceeded(requested: number): FileFnError {
  return new FileFnError(ErrorCodes.QUOTA_EXCEEDED, "The file owner's storage quota is exceeded", 402, { requested });
}

export function rateLimited(resetAt: string): FileFnError {
  return new FileFnError(ErrorCodes.RATE_LIMITED, 'Rate limit exceeded', 429, { resetAt });
}

export function invalidPartNumber(): FileFnError {
  return new FileFnError(ErrorCodes.INVALID_PART_NUMBER, 'Invalid partNumber', 400);
}

export function invalidEtag(): FileFnError {
  return new FileFnError(ErrorCodes.INVALID_ETAG, 'Invalid etag', 400);
}

export function uploadIncomplete(): FileFnError {
  return new FileFnError(ErrorCodes.UPLOAD_INCOMPLETE, 'Upload incomplete', 409);
}

export function uploadExpired(): FileFnError {
  return new FileFnError(ErrorCodes.UPLOAD_EXPIRED, 'Upload session expired', 410);
}

export function uploadAborted(): FileFnError {
  return new FileFnError(ErrorCodes.UPLOAD_ABORTED, 'Upload session was aborted', 410);
}

export function uploadAlreadyCompleted(): FileFnError {
  return new FileFnError(ErrorCodes.UPLOAD_ALREADY_COMPLETED, 'Upload session already completed', 409);
}

export function idempotencyConflict(): FileFnError {
  return new FileFnError(ErrorCodes.IDEMPOTENCY_CONFLICT, 'Idempotency key reuse with different payload', 409);
}

/**
 * An offline replay (`x-filefn-replay-scope`) whose credentials resolve to
 * another owner or tenant than the one its first `upload/init` recorded.
 * Nothing was created: the client keeps the outcome provisional under the
 * same key.
 */
export function replayScopeMismatch(): FileFnError {
  return new FileFnError(
    ErrorCodes.REPLAY_SCOPE_MISMATCH,
    "The replay's credentials act for another owner or tenant than its first upload/init",
    409,
  );
}

export function noSupportedUploadMode(): FileFnError {
  return new FileFnError(
    ErrorCodes.NO_SUPPORTED_UPLOAD_MODE,
    'No supported upload mode for configured adapter',
    500
  );
}

/**
 * FileFn could not verify the declared upload size. This covers adapters
 * without stat support and failures to stat objects during completion.
 */
export function storageStatUnavailable(): FileFnError {
  return new FileFnError(
    ErrorCodes.STORAGE_STAT_UNAVAILABLE,
    'Upload size cannot be verified',
    500,
  );
}

export function sessionNotFound(): FileFnError {
  return new FileFnError(ErrorCodes.SESSION_NOT_FOUND, 'Upload session not found', 404);
}

export function shareExpired(): FileFnError {
  return new FileFnError(ErrorCodes.SHARE_EXPIRED, 'Share link has expired', 410);
}

export function shareRevoked(): FileFnError {
  return new FileFnError(ErrorCodes.SHARE_REVOKED, 'Share link has been revoked', 410);
}

export function shareDownloadsExceeded(): FileFnError {
  return new FileFnError(ErrorCodes.SHARE_DOWNLOADS_EXCEEDED, 'Share link download limit exceeded', 410);
}

export function shareNotFound(): FileFnError {
  return new FileFnError(ErrorCodes.SHARE_NOT_FOUND, 'Share link not found', 404);
}

export function permissionNotFound(): FileFnError {
  return new FileFnError(ErrorCodes.PERMISSION_NOT_FOUND, 'Permission not found', 404);
}

export function sessionTokenRequired(): FileFnError {
  return new FileFnError(
    ErrorCodes.SESSION_TOKEN_REQUIRED,
    'Upload session token required',
    401
  );
}

export function sessionTokenInvalid(): FileFnError {
  return new FileFnError(
    ErrorCodes.SESSION_TOKEN_INVALID,
    'Invalid upload session token',
    403
  );
}

export function processingEnqueueFailed(): FileFnError {
  return new FileFnError(
    ErrorCodes.PROCESSING_ENQUEUE_FAILED,
    'Failed to enqueue processing',
    503
  );
}

export function invalidRenderIntent(intent?: string): FileFnError {
  return new FileFnError(
    ErrorCodes.INVALID_RENDER_INTENT,
    'Invalid render intent',
    400,
    { intent }
  );
}

export function partConflict(uploadSessionId: string, partNumber: number): FileFnError {
  return new FileFnError(
    ErrorCodes.PART_CONFLICT,
    'Part already completed with a different etag',
    409,
    { uploadSessionId, partNumber }
  );
}

export function uploadSizeMismatch(expected: number, actual: number): FileFnError {
  return new FileFnError(
    ErrorCodes.UPLOAD_SIZE_MISMATCH,
    'Uploaded size does not match expected size',
    409,
    { expected, actual }
  );
}

export function partTooLarge(partNumber: number, maxBytes: number): FileFnError {
  return new FileFnError(
    ErrorCodes.PART_TOO_LARGE,
    'Upload part is larger than the session allows for it',
    413,
    { partNumber, maxBytes }
  );
}

export function offlineUnsupported(): FileFnError {
  return new FileFnError(
    ErrorCodes.OFFLINE_UNSUPPORTED,
    'OPFS unavailable',
    400
  );
}

export function storagePathNotPerVersion(policy: string): FileFnError {
  return new FileFnError(
    ErrorCodes.STORAGE_PATH_NOT_PER_VERSION,
    'Policy storagePath must return a key that contains the full versionId',
    500,
    { policy }
  );
}

export function invalidFileId(): FileFnError {
  return new FileFnError(
    ErrorCodes.INVALID_FILE_ID,
    'fileId must match file_[A-Za-z0-9_-]{8,64}',
    400
  );
}

export function uploadCompletionInProgress(): FileFnError {
  return new FileFnError(
    ErrorCodes.UPLOAD_COMPLETION_IN_PROGRESS,
    'Another completion of this upload session or file is still running; retry the completion later',
    409,
    { retryable: true }
  );
}

export function invalidRequest(message: string, details?: Record<string, unknown>): FileFnError {
  return new FileFnError(ErrorCodes.INVALID_REQUEST, message, 400, details);
}

export function artifactKindNotAllowed(kind: string, allowedKinds: string[]): FileFnError {
  return new FileFnError(
    ErrorCodes.ARTIFACT_KIND_NOT_ALLOWED,
    'Artifact kind not allowed',
    400,
    { kind, allowedKinds },
  );
}

export function artifactTypeNotAllowed(kind: string, mimeType: string, allowedMimeTypes: string[]): FileFnError {
  return new FileFnError(
    ErrorCodes.ARTIFACT_TYPE_NOT_ALLOWED,
    'Artifact content type not allowed',
    415,
    { kind, mimeType, allowedMimeTypes },
  );
}

export function artifactTooLarge(kind: string, maxSizeBytes: number): FileFnError {
  return new FileFnError(
    ErrorCodes.ARTIFACT_TOO_LARGE,
    'Artifact exceeds the size limit for its kind',
    413,
    { kind, maxSizeBytes },
  );
}

export function artifactWriteConflict(kind: string): FileFnError {
  return new FileFnError(
    ErrorCodes.ARTIFACT_WRITE_CONFLICT,
    'Concurrent writes of this artifact kind kept replacing each other; retry the upload',
    409,
    { kind, retryable: true },
  );
}

/**
 * The storage target can take neither a streamed server-side upload nor a
 * PUT to a URL it signs, so FileFn cannot store a body it receives itself,
 * such as a client-supplied artifact.
 */
export function storageUploadUnsupported(target: string): FileFnError {
  return new FileFnError(
    ErrorCodes.STORAGE_UPLOAD_UNSUPPORTED,
    'The storage target does not support server-side uploads',
    501,
    { target },
  );
}

/** `importObject`: no object exists at the storage key. */
export function importObjectNotFound(storageKey: string): FileFnError {
  return new FileFnError(ErrorCodes.IMPORT_OBJECT_NOT_FOUND, 'Storage object to import not found', 404, { storageKey });
}

/** `importObject`: the object's stored size is not the size the caller gave. */
export function importSizeMismatch(storageKey: string, expected: number, actual: number): FileFnError {
  return new FileFnError(
    ErrorCodes.IMPORT_SIZE_MISMATCH,
    'Stored object size does not match the expected size',
    409,
    { storageKey, expected, actual },
  );
}

/**
 * `importObject`: the object was imported for another owner (`owner`), or the
 * requested file ID names another file (`fileId`).
 */
export function importConflict(storageKey: string, reason: 'owner' | 'fileId', fileId?: string): FileFnError {
  return new FileFnError(
    ErrorCodes.IMPORT_CONFLICT,
    reason === 'owner'
      ? 'Storage object was already imported for another owner'
      : 'File ID already names another file',
    409,
    fileId === undefined ? { storageKey, reason } : { storageKey, reason, fileId },
  );
}

export function unsupportedMediaType(): FileFnError {
  return new FileFnError(
    ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
    'This route takes a JSON body: send Content-Type: application/json',
    415
  );
}

export function bodyTooLarge(maxBytes: number): FileFnError {
  return new FileFnError(ErrorCodes.BODY_TOO_LARGE, 'Request body is too large', 413, { maxBytes });
}
