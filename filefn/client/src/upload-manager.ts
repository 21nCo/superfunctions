import type { HttpClient } from "./client.js";
import type {
  InitUploadResponse,
  PendingLocalDescriptor,
  UploadInput,
  UploadHandle,
  UploadProgress,
  UploadResult,
  UploadStatusResponse,
} from "./types.js";
import type {
  PendingLocalSourceMetadata,
  UploadPreprocessor,
  UploadPreprocessorContext,
} from "./preprocessing/types.js";

interface UploadSession {
  uploadSessionId: string;
  totalParts: number;
  chunkSizeBytes: number;
  fileSize: number;
}

export interface PreparedUploadInput {
  fileId: string;
  file: File | Blob;
  fileName: string;
  mimeType: string;
  size: number;
  metadata?: Record<string, unknown>;
  policy: string;
  idempotencyKey?: string;
  localSource: PendingLocalSourceMetadata;
}

const FILE_ID_MISMATCH_ERROR = 'FILEFN_CLIENT_FILE_ID_MISMATCH';
/**
 * The idempotency key replayed a session the server reports as aborted or
 * expired. Nothing more can be uploaded under that key: start again with a
 * new one. `details.status` is the reported status.
 */
export const UPLOAD_SESSION_ENDED_ERROR = 'FILEFN_UPLOAD_SESSION_ENDED';
/** A replayed completed session's file could not be read back to confirm it. */
export const UPLOAD_RECONCILE_FAILED_ERROR = 'FILEFN_UPLOAD_RECONCILE_FAILED';
/** A completion response without a well-formed fileId and versionId: its outcome is unknown. */
export const UPLOAD_RESULT_INVALID_ERROR = 'FILEFN_UPLOAD_RESULT_INVALID';

/** A server-issued identifier: a non-empty string without whitespace or control characters. */
export function isWellFormedId(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value);
}

function createClientError(code: string, message: string, details?: Record<string, unknown>): Error & {
  code: string;
  details?: Record<string, unknown>;
} {
  const error = new Error(message) as Error & {
    code: string;
    details?: Record<string, unknown>;
  };
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function currentFileName(file: File | Blob, fallback?: string): string {
  if (fallback) {
    return fallback;
  }
  if (typeof File !== 'undefined' && file instanceof File) {
    return file.name;
  }
  return 'blob';
}

function currentMimeType(file: File | Blob): string {
  return file.type || 'application/octet-stream';
}

export function derivePendingLocalSource(
  fileName: string,
  mimeType: string,
  size: number,
): PendingLocalSourceMetadata {
  if (mimeType.startsWith('image/')) {
    return {
      mode: 'local-object-url',
      kind: 'image',
      fileName,
      mimeType,
      size,
      opfsDataFile: 'data.bin',
      previewBehavior: 'direct-image',
    };
  }

  if (mimeType === 'application/pdf') {
    return {
      mode: 'local-object-url',
      kind: 'pdf',
      fileName,
      mimeType,
      size,
      opfsDataFile: 'data.bin',
      previewBehavior: 'deterministic-placeholder',
    };
  }

  return {
    mode: 'local-object-url',
    kind: 'binary',
    fileName,
    mimeType,
    size,
    opfsDataFile: 'data.bin',
    previewBehavior: 'download-only',
  };
}

/**
 * Grammar the FileFn server accepts for a client-chosen file ID. Duplicated from
 * `@filefn/server` on purpose: the client does not depend on the server package.
 */
const FILE_ID_PATTERN = /^file_[A-Za-z0-9_-]{8,64}$/;
const INVALID_FILE_ID_ERROR = 'FILEFN_INVALID_FILE_ID';

/** Whether `value` is a file ID the server accepts in `upload/init`. */
export function isValidFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID_PATTERN.test(value);
}

export function createInvalidFileIdError(fileId: unknown): Error & {
  code: string;
  details?: Record<string, unknown>;
} {
  return createClientError(INVALID_FILE_ID_ERROR, 'fileId must match file_[A-Za-z0-9_-]{8,64}', { fileId });
}

/** Throws `FILEFN_INVALID_FILE_ID` unless an explicit `fileId` matches the server grammar. */
export function assertValidExplicitFileId(fileId: unknown): void {
  if (fileId !== undefined && fileId !== null && !isValidFileId(fileId)) {
    throw createInvalidFileIdError(fileId);
  }
}

/**
 * An idempotency key travels in the `x-idempotency-key` header, which trims
 * whitespace and allows only Latin-1: visible ASCII is the only form the
 * server receives exactly as given, so two keys never alias on the wire.
 */
export function isValidIdempotencyKey(key: unknown, maxLength = 255): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= maxLength && /^[\x21-\x7e]+$/.test(key);
}

/** Throws `FILEFN_INVALID_IDEMPOTENCY_KEY` unless an explicit key is 1-255 visible ASCII characters. */
export function assertValidIdempotencyKey(key: unknown): void {
  if (key !== undefined && !isValidIdempotencyKey(key)) {
    throw createClientError('FILEFN_INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be 1-255 visible ASCII characters');
  }
}

export function generateFileId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `file_${cryptoApi.randomUUID().replace(/-/g, '')}`;
  }

  return `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function prepareUploadInput(
  input: UploadInput,
  preprocessors: UploadPreprocessor[] = [],
): Promise<PreparedUploadInput> {
  // Covers every path that reaches upload/init, including offline replay of a
  // stored record whose fileId is not grammar-valid.
  assertValidExplicitFileId(input.fileId);
  const fileId = input.fileId ?? generateFileId();
  let prepared: PreparedUploadInput = {
    fileId,
    file: input.file,
    fileName: currentFileName(input.file, input.fileName),
    mimeType: currentMimeType(input.file),
    size: input.file.size,
    metadata: input.metadata,
    policy: input.policy,
    idempotencyKey: input.idempotencyKey,
    localSource: derivePendingLocalSource(
      currentFileName(input.file, input.fileName),
      currentMimeType(input.file),
      input.file.size,
    ),
  };

  for (const preprocessor of preprocessors) {
    const context: UploadPreprocessorContext = {
      fileId,
      file: prepared.file,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      metadata: prepared.metadata,
      localSource: prepared.localSource,
    };
    const matches = await preprocessor.matches(context);
    if (!matches) {
      continue;
    }

    const result = await preprocessor.process(context);
    const nextFile = result.file;
    const nextFileName = result.fileName || currentFileName(nextFile, prepared.fileName);
    const derivedMimeType = currentMimeType(nextFile);
    const nextMimeType =
      result.mimeType ||
      (derivedMimeType !== 'application/octet-stream' ? derivedMimeType : prepared.mimeType);
    const nextMetadata = result.metadata ?? prepared.metadata;
    const nextLocalSource = {
      ...derivePendingLocalSource(nextFileName, nextMimeType, nextFile.size),
      ...result.localSource,
      fileName: nextFileName,
      mimeType: nextMimeType,
      size: nextFile.size,
    };

    prepared = {
      ...prepared,
      file: nextFile,
      fileName: nextFileName,
      mimeType: nextMimeType,
      size: nextFile.size,
      metadata: nextMetadata,
      localSource: nextLocalSource,
    };
  }

  return prepared;
}

export class UploadManager {
  private progressCallbacks: Array<(progress: UploadProgress) => void> = [];
  private abortController: AbortController;
  private session: UploadSession | null = null;
  private file: Blob | null = null;
  private completedParts: Set<number> = new Set();
  private bytesUploaded = 0;
  private uploadSessionToken?: string;

  constructor(
    private readonly httpClient: HttpClient,
    private readonly preprocessors: UploadPreprocessor[] = [],
  ) {
    this.abortController = new AbortController();
  }

  bindAbortSignal(signal: AbortSignal | undefined): void {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      this.abortController.abort();
      return;
    }
    signal.addEventListener('abort', () => {
      this.abortController.abort();
    }, { once: true });
  }

  createHandle(
    input: UploadInput,
    startUpload: (handle: UploadHandle) => Promise<UploadResult>,
    initialState?: Partial<Pick<UploadHandle, 'uploadSessionId' | 'uploadSessionToken' | 'fileId'>>,
  ): UploadHandle {
    let uploadPromise: Promise<UploadResult> | null = null;
    const isResumedUpload = Boolean(initialState?.uploadSessionId);
    const fileId = input.fileId ?? (isResumedUpload ? undefined : generateFileId());
    if (!input.fileId && fileId) {
      input.fileId = fileId;
    }

    const handle: UploadHandle = {
      uploadSessionId: initialState?.uploadSessionId ?? "",
      uploadSessionToken: initialState?.uploadSessionToken,
      fileId: initialState?.fileId ?? fileId,
      onProgress: (callback) => {
        this.progressCallbacks.push(callback);
      },
      abort: () => {
        this.abortController.abort();
      },
      done: async () => {
        if (!uploadPromise) {
          uploadPromise = startUpload(handle);
        }
        const result = await uploadPromise;
        handle.uploadSessionId = this.session?.uploadSessionId || "";
        handle.uploadSessionToken = this.uploadSessionToken;
        handle.fileId = result.fileId;
        return result;
      },
    };

    return handle;
  }

  async startUpload(input: UploadInput, handle?: UploadHandle): Promise<UploadResult> {
    const signal = this.abortController.signal;
    const prepared = await prepareUploadInput(input, [...this.preprocessors, ...(input.preprocessors || [])]);
    this.file = prepared.file;

    const rawInit = await this.httpClient.initUpload(
      {
        policy: prepared.policy,
        fileName: prepared.fileName,
        size: prepared.size,
        mimeType: prepared.mimeType,
        metadata: prepared.metadata,
        fileId: prepared.fileId,
        idempotencyKey: prepared.idempotencyKey,
      },
      signal,
    );

    // Accept both unwrapped { uploadSessionId, ... } and envelope { data: { uploadSessionId, ... } }
    const initResponse = (
      rawInit && typeof rawInit === "object" && "uploadSessionId" in rawInit
        ? rawInit
        : (rawInit as { data?: Partial<InitUploadResponse> })?.data
    ) as Partial<InitUploadResponse>;

    const uploadSessionId = initResponse?.uploadSessionId;
    if (!uploadSessionId) {
      throw new Error(
        "Failed to create upload session: no session ID returned. Ensure the server returns { ok: true, data: { uploadSessionId, totalParts, chunkSizeBytes, ... } } or { uploadSessionId, ... }.",
      );
    }

    this.session = {
      uploadSessionId,
      totalParts: initResponse.totalParts ?? 1,
      chunkSizeBytes: initResponse.chunkSizeBytes ?? 0,
      fileSize: prepared.size,
    };
    this.uploadSessionToken = initResponse.uploadSessionToken;
    if (handle) {
      handle.uploadSessionId = uploadSessionId;
      handle.uploadSessionToken = this.uploadSessionToken;
      handle.fileId = prepared.fileId;
    }

    // An idempotent replay reports the session it found.
    if (initResponse.status === "completed") {
      return this.reconcileCompletedSession(initResponse, prepared.fileId, signal);
    }
    if (initResponse.status === "aborted" || initResponse.status === "expired") {
      throw createClientError(
        UPLOAD_SESSION_ENDED_ERROR,
        `Upload session ${uploadSessionId} is ${initResponse.status}; start again with a new idempotency key`,
        { uploadSessionId, status: initResponse.status },
      );
    }
    if (initResponse.status === "in_progress") {
      // Skip the parts the server already recorded.
      const status = await this.httpClient.getUploadStatus(uploadSessionId, this.uploadSessionToken, signal);
      this.completedParts = new Set(status.recordedParts || status.uploadedParts || []);
      this.bytesUploaded = this.calculateUploadedBytes(status);
    }

    await this.uploadAllParts(signal);

    const result = await this.httpClient.completeUpload(
      this.session.uploadSessionId,
      this.uploadSessionToken,
      signal,
    );

    if (!isWellFormedId(result?.fileId) || !isWellFormedId(result?.versionId)) {
      // A success that does not name what it stored confirms nothing: the
      // outcome is unknown and a replay under the same key settles it.
      throw createClientError(UPLOAD_RESULT_INVALID_ERROR, 'Upload completion did not name a stored file and version', {
        uploadSessionId: this.session.uploadSessionId,
      });
    }
    if (result.fileId !== prepared.fileId) {
      throw createClientError(
        FILE_ID_MISMATCH_ERROR,
        'Server completed upload with a different fileId than the client requested',
        {
          expectedFileId: prepared.fileId,
          actualFileId: result.fileId,
        },
      );
    }

    return result;
  }

  /**
   * A replayed session already completed: read the recorded version back and
   * return it, without signing or sending any part again. A version that no
   * longer exists (its file was deleted, even if the ID was reused since) is
   * never confirmed.
   */
  private async reconcileCompletedSession(
    initResponse: Partial<InitUploadResponse>,
    expectedFileId: string,
    signal: AbortSignal,
  ): Promise<UploadResult> {
    const { fileId, versionId } = initResponse;
    if (!isWellFormedId(fileId) || !isWellFormedId(versionId)) {
      throw createClientError(UPLOAD_RECONCILE_FAILED_ERROR, 'Completed session did not report its stored file', {
        uploadSessionId: initResponse.uploadSessionId,
      });
    }
    if (fileId !== expectedFileId) {
      throw createClientError(
        FILE_ID_MISMATCH_ERROR,
        'Server completed upload with a different fileId than the client requested',
        { expectedFileId, actualFileId: fileId },
      );
    }
    let stored: Record<string, unknown>;
    try {
      stored = await this.httpClient.getFileVersion(fileId, versionId, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw Object.assign(
        createClientError(UPLOAD_RECONCILE_FAILED_ERROR, 'Stored file of a completed session could not be read back', {
          uploadSessionId: initResponse.uploadSessionId,
          fileId,
        }),
        { cause: error },
      );
    }
    if (stored?.fileId !== fileId || stored?.versionId !== versionId) {
      throw createClientError(UPLOAD_RECONCILE_FAILED_ERROR, 'Stored version read back does not match the completed session', {
        uploadSessionId: initResponse.uploadSessionId,
        fileId,
      });
    }
    return { fileId, versionId };
  }

  async resumeUpload(
    uploadSessionId: string,
    file: Blob,
    uploadSessionToken?: string,
    handle?: UploadHandle,
  ): Promise<UploadResult> {
    const signal = this.abortController.signal;
    this.file = file;
    this.uploadSessionToken = uploadSessionToken;

    const status = await this.httpClient.getUploadStatus(
      uploadSessionId,
      this.uploadSessionToken,
      signal,
    );

    this.session = {
      uploadSessionId,
      totalParts: status.totalParts,
      chunkSizeBytes: status.chunkSizeBytes,
      fileSize: status.fileSize,
    };
    if (handle) {
      handle.uploadSessionId = uploadSessionId;
      handle.uploadSessionToken = this.uploadSessionToken;
      if (status.fileId) {
        handle.fileId = status.fileId;
      }
    }

    const recordedParts = status.recordedParts || status.uploadedParts || [];
    this.completedParts = new Set(recordedParts);
    this.bytesUploaded = this.calculateUploadedBytes(status);

    this.emitProgress();

    await this.uploadAllParts(signal);

    const result = await this.httpClient.completeUpload(
      uploadSessionId,
      this.uploadSessionToken,
      signal,
    );
    if (handle) {
      handle.fileId = result.fileId;
    }
    return result;
  }

  private calculateUploadedBytes(status: UploadStatusResponse): number {
    let bytes = 0;
    const recordedParts = status.recordedParts || status.uploadedParts || [];
    for (const partNum of recordedParts) {
      if (partNum < status.totalParts) {
        bytes += status.chunkSizeBytes;
      } else {
        bytes +=
          status.fileSize - (status.totalParts - 1) * status.chunkSizeBytes;
      }
    }
    return bytes;
  }

  private async uploadAllParts(signal: AbortSignal): Promise<void> {
    if (!this.session || !this.file) {
      throw new Error("No active session");
    }

    for (let partNum = 1; partNum <= this.session.totalParts; partNum++) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (this.completedParts.has(partNum)) {
        continue;
      }

      await this.uploadPart(partNum, signal);
    }
  }

  private async uploadPart(
    partNumber: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.session || !this.file) {
      throw new Error("No active session");
    }

    const { uploadSessionId, chunkSizeBytes, totalParts, fileSize } =
      this.session;

    const start = (partNumber - 1) * chunkSizeBytes;
    const end = partNumber === totalParts ? fileSize : start + chunkSizeBytes;
    const chunk = this.file.slice(start, end);

    const signResponse = await this.httpClient.signPart(
      uploadSessionId,
      partNumber,
      chunk.size,
      this.uploadSessionToken,
      signal,
    );

    const { etag, recorded } = await this.httpClient.uploadPartToSignedUrl(
      signResponse.url,
      signResponse.headers || {},
      chunk,
      this.uploadSessionToken,
      signal,
      { uploadSessionId, partNumber },
    );

    if (!recorded) {
      await this.httpClient.completePart(
        uploadSessionId,
        partNumber,
        etag,
        chunk.size,
        this.uploadSessionToken,
        signal,
      );
    }

    this.completedParts.add(partNumber);
    this.bytesUploaded += chunk.size;
    this.emitProgress();
  }

  private emitProgress(): void {
    if (!this.session) return;

    const progress: UploadProgress = {
      bytesUploaded: this.bytesUploaded,
      bytesTotal: this.session.fileSize,
      partsCompleted: this.completedParts.size,
      totalParts: this.session.totalParts,
    };

    for (const callback of this.progressCallbacks) {
      try {
        callback(progress);
      } catch {
        // Ignore callback errors
      }
    }
  }
}
