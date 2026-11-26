import type { HttpClient } from "./client.js";
import type {
  InitUploadResponse,
  PendingLocalDescriptor,
  ReplayAccount,
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

/**
 * Session ends this client confirmed itself (a decoded, self-consistent
 * `upload/init` replay reporting aborted or expired) or that a custom offline
 * uploader confirmed through `createUploadSessionEndedError`. Only these
 * retire an offline replay key: an error that merely carries the code, such
 * as a server refusal naming `FILEFN_UPLOAD_SESSION_ENDED`, does not.
 */
const confirmedSessionEnds = new WeakSet<object>();

/**
 * The error that confirms an upload session of the replay key ended for good
 * (aborted or expired). A custom `OfflineQueueUploader` throws it only when
 * it confirmed that end itself; the queue then journals a fresh key before
 * the next request. Any other error, whatever its code, leaves the outcome
 * unknown under the same key.
 */
export function createUploadSessionEndedError(
  uploadSessionId: string,
  status: 'aborted' | 'expired',
): Error & { code: string; details: Record<string, unknown> } {
  const error = Object.assign(
    new Error(`Upload session ${uploadSessionId} is ${status}; start again with a new idempotency key`),
    { code: UPLOAD_SESSION_ENDED_ERROR, details: { uploadSessionId, status } as Record<string, unknown> },
  );
  confirmedSessionEnds.add(error);
  return error;
}

/** Whether an error is a confirmed session end (see `createUploadSessionEndedError`). */
export function isConfirmedSessionEnd(error: unknown): boolean {
  return typeof error === 'object' && error !== null && confirmedSessionEnds.has(error);
}
/** A replayed completed session's file could not be read back to confirm it. */
export const UPLOAD_RECONCILE_FAILED_ERROR = 'FILEFN_UPLOAD_RECONCILE_FAILED';
/**
 * An offline replay's credentials resolved to another owner or tenant than
 * the scope its first `upload/init` pinned (the server's 409, or a response
 * naming another scope). Nothing more is sent: the outcome stays unknown
 * under the same key until the right account replays it.
 */
export const REPLAY_SCOPE_MISMATCH_ERROR = 'FILEFN_REPLAY_SCOPE_MISMATCH';
/**
 * A marked offline replay whose `upload/init` response named no scope (a
 * server before 0.8 ignores the marker, and may have resolved no account at
 * all): nothing more is sent under it, and the outcome stays unknown.
 */
export const REPLAY_SCOPE_UNCONFIRMED_ERROR = 'FILEFN_REPLAY_SCOPE_UNCONFIRMED';

/**
 * Binds an offline replay's sessions to one account. Every `upload/init`,
 * the generation's first included, sends `x-filefn-replay-scope: <scope>`,
 * the scope journaled with the generation's replay identity before its first
 * request. The server refuses a marked init from an anonymous caller (401)
 * or from another owner or tenant (409), creating nothing, so no session is
 * ever created or advanced under another account.
 */
export interface UploadReplayScope {
  scope: string;
}

/** A replay scope as the server issues it: 1-255 visible ASCII characters. */
export function isReplayScope(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value);
}

/**
 * The replay scope of `account`, as `@filefn/server` computes it for an
 * authenticated caller: `rs_` and the hex SHA-256 of
 * `["filefn-replay-scope", principalId, tenantId ?? null]` as JSON. An
 * unusable account (no principal ID, or the shared `anonymous` one) or no Web
 * Crypto refuses with `FILEFN_REPLAY_SCOPE_UNCONFIRMED`: nothing is sent.
 */
export async function replayScopeOf(account: ReplayAccount): Promise<string> {
  const { principalId, tenantId } = account ?? ({} as ReplayAccount);
  if (
    typeof principalId !== 'string' ||
    principalId === '' ||
    principalId === 'anonymous' ||
    (tenantId !== undefined && tenantId !== null && typeof tenantId !== 'string')
  ) {
    throw createClientError(REPLAY_SCOPE_UNCONFIRMED_ERROR, 'An offline replay needs the server account it acts for: a non-anonymous principalId');
  }
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw createClientError(REPLAY_SCOPE_UNCONFIRMED_ERROR, 'An offline replay needs Web Crypto (crypto.subtle) to bind its account');
  }
  const data = new TextEncoder().encode(JSON.stringify(['filefn-replay-scope', principalId, tenantId ?? null]));
  const digest = new Uint8Array(await subtle.digest('SHA-256', data));
  return `rs_${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
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

  async startUpload(input: UploadInput, handle?: UploadHandle, replay?: UploadReplayScope): Promise<UploadResult> {
    const signal = this.abortController.signal;
    const prepared = await prepareUploadInput(input, [...this.preprocessors, ...(input.preprocessors || [])]);
    this.file = prepared.file;

    const init = () =>
      this.httpClient.initUpload(
        {
          policy: prepared.policy,
          fileName: prepared.fileName,
          size: prepared.size,
          mimeType: prepared.mimeType,
          metadata: prepared.metadata,
          fileId: prepared.fileId,
          idempotencyKey: prepared.idempotencyKey,
          ...(replay ? { replayScope: replay.scope } : {}),
        },
        signal,
      );
    // Decoded by the transport (`FileFnResult`): a well-formed session, and a
    // completed one names its stored file and version. Anything else was
    // thrown as a refusal or an unknown outcome.
    const initResponse = await init();
    const uploadSessionId = initResponse.uploadSessionId;
    if (replay) this.checkReplayScope(initResponse, replay);

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
      // A decoded success with a well-formed session confirms the end (and
      // retires the key).
      throw createUploadSessionEndedError(uploadSessionId, initResponse.status);
    }
    // A session whose completion was already decided gets no part again
    // (an adopted earlier publication may have no part records left): the
    // completion call finishes it.
    let completionStarted = initResponse.status === "in_progress" && initResponse.completionStarted === true;
    if (initResponse.status === "in_progress" && !completionStarted) {
      // Skip the parts the server already recorded.
      const status = await this.httpClient.getUploadStatus(uploadSessionId, this.uploadSessionToken, signal);
      if (status.status === "completed") {
        // Completed since the init answered: the same key's replay reports
        // the recorded version, which is reconciled (no part is sent).
        const replayed = await init();
        if (replay) this.checkReplayScope(replayed, replay);
        if (replayed.uploadSessionId === uploadSessionId && replayed.status === "completed") {
          return this.reconcileCompletedSession(replayed, prepared.fileId, signal);
        }
        throw new Error("Upload session completed meanwhile, but its replay did not report it; the outcome is unknown");
      }
      if (status.status === "aborted" || status.status === "expired") {
        // Only an upload/init replay confirms an end (and retires the key).
        throw new Error(`Upload session ${uploadSessionId} reads ${status.status}; its replay settles it`);
      }
      completionStarted = status.completionStarted === true;
      this.completedParts = new Set(status.recordedParts || status.uploadedParts || []);
      this.bytesUploaded = this.calculateUploadedBytes(status);
    }

    if (!completionStarted) await this.uploadAllParts(signal);

    const result = await this.httpClient.completeUpload(
      this.session.uploadSessionId,
      this.uploadSessionToken,
      signal,
    );

    // Decoded by the transport: it names a stored file and version.
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
   * The scope check of a marked offline replay: the response must name the
   * journaled scope the init sent, or nothing more is sent under it.
   */
  private checkReplayScope(initResponse: InitUploadResponse, replay: UploadReplayScope): void {
    const scope = initResponse.replayScope;
    if (!isReplayScope(scope)) {
      throw createClientError(
        REPLAY_SCOPE_UNCONFIRMED_ERROR,
        "The server did not confirm the account of this offline replay (x-filefn-replay-scope needs @filefn/server 0.8 or later)",
        { uploadSessionId: initResponse?.uploadSessionId },
      );
    }
    if (scope !== replay.scope) {
      throw createClientError(REPLAY_SCOPE_MISMATCH_ERROR, "The replay's credentials act for another account than its journaled scope", {
        uploadSessionId: initResponse.uploadSessionId,
      });
    }
  }

  /**
   * A replayed session already completed: read the recorded version back and
   * return it, without signing or sending any part again. A version that no
   * longer exists (its file was deleted, even if the ID was reused since) is
   * never confirmed.
   */
  private async reconcileCompletedSession(
    initResponse: InitUploadResponse,
    expectedFileId: string,
    signal: AbortSignal,
  ): Promise<UploadResult> {
    // Decoded by the transport: a completed session names a well-formed file and version.
    const fileId = initResponse.fileId!;
    const versionId = initResponse.versionId!;
    if (fileId !== expectedFileId) {
      throw createClientError(
        FILE_ID_MISMATCH_ERROR,
        'Server completed upload with a different fileId than the client requested',
        { expectedFileId, actualFileId: fileId },
      );
    }
    // The server confirmed, for the session's owner, that the recorded version
    // is still stored under its file: settle without a file read, which a
    // write-only uploader may not be allowed (servers before this flag are
    // read back below).
    if (initResponse.versionConfirmed === true) return { fileId, versionId };
    let stored: Record<string, unknown>;
    try {
      stored = await this.httpClient.getFileVersion(fileId, versionId, signal);
    } catch (error) {
      // An abort and a queue control error (a hold, a principal switch or a
      // disposal fencing the request) say nothing about the stored file: they
      // pass through unchanged, so the queue spends no attempt on them.
      if (isControlError(error)) throw error;
      throw Object.assign(
        createClientError(UPLOAD_RECONCILE_FAILED_ERROR, 'Stored file of a completed session could not be read back', {
          uploadSessionId: initResponse.uploadSessionId,
          fileId,
        }),
        { cause: error },
      );
    }
    if (stored.fileId !== fileId || stored.versionId !== versionId) {
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

/** An abort, or an offline queue control error (`FILEFN_QUEUE_*`). */
function isControlError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('FILEFN_QUEUE_');
}
