import type {
  ArtifactDescriptor,
  ClientArtifactKind,
  RenderDescriptor,
  FileFnClientConfig,
  InitUploadResponse,
  UploadStatusResponse,
  SignPartResponse,
  CompletePartResponse,
  CompleteUploadResponse,
  AbortUploadResponse,
} from "./types.js";
import {
  resolveRetryOptions,
  withRetry,
  type ResolvedRetryOptions,
} from "./retry.js";
import { isValidFileId } from "./upload-manager.js";

export interface FileFnErrorDetails {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class FileFnHttpError extends Error {
  public readonly code?: string;
  public readonly requestId?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "FileFnHttpError";

    // Extract structured error from canonical envelope
    if (body && typeof body === "object" && "error" in body) {
      const envelope = body as {
        ok: false;
        error: FileFnErrorDetails;
        requestId?: string;
      };
      this.code = envelope.error.code;
      this.details = envelope.error.details;
      if (envelope.requestId) {
        this.requestId = envelope.requestId;
      }
    }
  }
}


/** A successful answer that does not prove what it claims: its outcome is unknown. */
export const UPLOAD_RESULT_INVALID_ERROR = "FILEFN_UPLOAD_RESULT_INVALID";

/**
 * A server-issued identifier such as a version or session ID. The server's
 * `generateId` may produce any string, so the client accepts any string of
 * 1-1024 characters that can name exactly one encoded path segment: not
 * blank, no control characters, and not a dot segment (`.` or `..`, which
 * `encodeURIComponent` leaves as they are and URL parsing collapses). Every
 * path built from an identifier encodes it (`encodeURIComponent`).
 */
export function isWellFormedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim().length > 0 &&
    value !== "." &&
    value !== ".." &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Checks a decoded payload: true when it has the route's shape. */
export type FileFnSchema<T> = (data: unknown) => data is T;

/**
 * What one FileFn answer proves, decided in one place (`decodeFileFnResult`):
 * - `ok`: a 2xx, not redirected, whose body is `{ ok: true, data }` (with no
 *   `error`), a legacy `{ data }` envelope (no `ok` or `error`) or a legacy
 *   bare body (no `ok`, `error` or object `data` member), and whose
 *   payload passes the route's schema;
 * - `refused`: a non-2xx from the verified FileFn route, not redirected, whose
 *   body is a FileFn error envelope with a code;
 * - `unknown`: anything else. A non-2xx that is not a coded FileFn refusal
 *   keeps only its HTTP status (`FileFnHttpError` without a code); a 2xx that
 *   proves nothing is `FILEFN_UPLOAD_RESULT_INVALID`. An offline replay keeps
 *   an unknown outcome provisional under the same key.
 */
export type FileFnResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "refused"; error: FileFnHttpError }
  | { kind: "unknown"; error: Error & { code?: string; status?: number } };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resultInvalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: UPLOAD_RESULT_INVALID_ERROR });
}

/**
 * The payload of a successful body, through the route's schema: the data of
 * `{ ok: true, data }` with no `error`, of a legacy `{ data }` envelope that
 * names no `ok` or `error`, or a bare legacy body. Any other body (an `ok` that is not `true`, an `error`,
 * a payload of another shape, a payload that itself carries an `ok` other
 * than `true` or a non-null `error`) proves nothing. Also used for a custom
 * offline uploader's result.
 */
export function decodeFileFnBody<T>(body: unknown, schema: FileFnSchema<T>): FileFnResult<T> {
  let payload: unknown = body;
  if (isObject(body) && ("ok" in body || "error" in body)) {
    if (body.ok !== true || (body.error !== undefined && body.error !== null)) {
      return { kind: "unknown", error: resultInvalid("The answer is not a FileFn success envelope") };
    }
    payload = body.data;
  } else if (isObject(body) && isObject(body.data)) {
    // A legacy `{ data: {...} }` envelope without `ok` (accepted since 0.x).
    payload = body.data;
  }
  if (isObject(payload) && (("ok" in payload && payload.ok !== true) || (payload.error !== undefined && payload.error !== null))) {
    return { kind: "unknown", error: resultInvalid("The answer's payload carries a failure marker") };
  }
  if (!schema(payload)) {
    return { kind: "unknown", error: resultInvalid("The answer does not have the route's shape") };
  }
  return { kind: "ok", data: payload };
}

/** A coded FileFn error envelope: `{ ok: false, error: { code, ... } }` (`ok` may be omitted). */
function isErrorEnvelope(body: unknown): boolean {
  return (
    isObject(body) &&
    (!("ok" in body) || body.ok === false) &&
    isObject(body.error) &&
    typeof body.error.code === "string" &&
    body.error.code.length > 0
  );
}

function optional<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === undefined || check(value);
}
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isPartList = (value: unknown): value is number[] => Array.isArray(value) && value.every(isCount);

const SESSION_STATUSES = new Set(["pending", "in_progress", "completed", "aborted", "expired"]);

/** The schemas of the upload-session routes' successful payloads. */
export const uploadSchemas = {
  /**
   * `upload/init`: a well-formed, self-consistent session. A completed one
   * names its stored file and version; only a completed one may carry
   * `versionConfirmed`, and only an in-progress one `completionStarted`. An
   * ended (aborted or expired) one carries neither and names no file or
   * version: a body that contradicts itself proves nothing.
   */
  init: (data: unknown): data is InitUploadResponse =>
    isObject(data) &&
    isWellFormedId(data.uploadSessionId) &&
    optional(data.uploadSessionToken, isString) &&
    optional(data.totalParts, isCount) &&
    optional(data.chunkSizeBytes, isCount) &&
    optional(data.replayScope, isString) &&
    optional(data.versionConfirmed, isBoolean) &&
    optional(data.completionStarted, isBoolean) &&
    (data.status === undefined || (typeof data.status === "string" && SESSION_STATUSES.has(data.status))) &&
    (data.status !== "completed" || (isValidFileId(data.fileId) && isWellFormedId(data.versionId))) &&
    (data.versionConfirmed === undefined || data.status === "completed") &&
    (data.completionStarted === undefined || data.status === "in_progress") &&
    ((data.status !== "aborted" && data.status !== "expired") ||
      (data.fileId === undefined && data.versionId === undefined)),
  status: (data: unknown): data is UploadStatusResponse =>
    isObject(data) &&
    typeof data.status === "string" &&
    SESSION_STATUSES.has(data.status) &&
    optional(data.recordedParts, isPartList) &&
    optional(data.uploadedParts, isPartList) &&
    optional(data.completionStarted, isBoolean),
  sign: (data: unknown): data is SignPartResponse =>
    isObject(data) && typeof data.url === "string" && data.url.length > 0 && optional(data.headers, isObject),
  /** A body-less success (204) or any object. */
  ack: <T>(data: unknown): data is T => data === undefined || isObject(data),
  /**
   * `upload/{id}/complete` and a version read: a stored file and version. A
   * payload that names a session status other than `completed` contradicts
   * itself and proves nothing.
   */
  stored: (data: unknown): data is CompleteUploadResponse =>
    isObject(data) &&
    isValidFileId(data.fileId) &&
    isWellFormedId(data.versionId) &&
    (data.status === undefined || data.status === "completed"),
  part: (data: unknown): data is { etag: string; recorded?: boolean } =>
    isObject(data) && optional(data.etag, isString) && optional(data.recorded, isBoolean),
} as const;

export interface HttpClient {
  initUpload(
    params: {
      policy: string;
      fileName: string;
      size: number;
      mimeType: string;
      metadata?: Record<string, unknown>;
      fileId?: string;
      idempotencyKey?: string;
      /** Marks an offline replay pinned to the scope of the account it must act for (`x-filefn-replay-scope`). */
      replayScope?: string;
    },
    signal?: AbortSignal,
  ): Promise<InitUploadResponse>;

  getFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;

  /** Metadata of one stored version (`GET /{fileId}/versions/{versionId}`). */
  getFileVersion(
    fileId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;

  listArtifacts(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactDescriptor[]>;

  downloadUrl(
    fileId: string,
    options?: { versionId?: string },
    signal?: AbortSignal,
  ): Promise<{ url: string }>;

  uploadArtifact(
    params: {
      fileId: string;
      versionId: string;
      kind: ClientArtifactKind;
      data: Blob | Uint8Array;
      mimeType: string;
      durationMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<ArtifactDescriptor>;

  downloadArtifact(
    fileId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; headers?: Record<string, string> }>;

  getRenderDescriptor(
    fileId: string,
    options: { intent: string; versionId?: string },
    signal?: AbortSignal,
  ): Promise<RenderDescriptor>;

  deleteFile(fileId: string, signal?: AbortSignal): Promise<void>;

  getUploadStatus(
    uploadSessionId: string,
    uploadSessionToken?: string,
    signal?: AbortSignal,
  ): Promise<UploadStatusResponse>;

  signPart(
    uploadSessionId: string,
    partNumber: number,
    contentLength: number,
    uploadSessionToken?: string,
    signal?: AbortSignal,
  ): Promise<SignPartResponse>;

  completePart(
    uploadSessionId: string,
    partNumber: number,
    etag: string,
    size: number,
    uploadSessionToken?: string,
    signal?: AbortSignal,
  ): Promise<CompletePartResponse>;

  completeUpload(
    uploadSessionId: string,
    uploadSessionToken?: string,
    signal?: AbortSignal,
  ): Promise<CompleteUploadResponse>;

  abortUpload(
    uploadSessionId: string,
    uploadSessionToken?: string,
    signal?: AbortSignal,
  ): Promise<AbortUploadResponse>;

  uploadPartToSignedUrl(
    url: string,
    headers: Record<string, string>,
    body: Blob,
    uploadSessionToken?: string,
    signal?: AbortSignal,
    /** The part this URL was signed for: the token then goes only to FileFn's exact endpoint for it. */
    expectedPart?: { uploadSessionId: string; partNumber: number },
  ): Promise<{ etag: string; recorded?: boolean }>;
}

const CREDENTIALS_MODES: readonly RequestCredentials[] = ["omit", "same-origin", "include"];

function resolveTransport(config: FileFnClientConfig): {
  send: (url: string, init: RequestInit) => Promise<Response>;
  credentials: RequestCredentials;
} {
  const customFetch = config.fetch;
  if (customFetch !== undefined && typeof customFetch !== "function") {
    throw new TypeError("FileFnClientConfig.fetch must be a function");
  }
  const credentials = config.credentials ?? "same-origin";
  if (!CREDENTIALS_MODES.includes(credentials)) {
    throw new TypeError(
      `FileFnClientConfig.credentials must be one of ${CREDENTIALS_MODES.join(", ")}`,
    );
  }

  return {
    // Call the injected fetch detached from `config` so browser fetch does not
    // throw "Illegal invocation"; resolve the global per call so it can be
    // replaced (polyfilled or stubbed) after the client is created.
    send: (url, init) => (customFetch ? customFetch(url, init) : globalThis.fetch(url, init)),
    credentials,
  };
}

/**
 * Merges header records from left to right. Header names are
 * case-insensitive, so a later source replaces an earlier header whatever its
 * casing, and the later source's spelling of the name is kept. Callers pass
 * the auth headers first so request-specific headers (JSON Content-Type,
 * signed part headers, x-upload-session-token) always win.
 */
function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const merged = new Map<string, [name: string, value: string]>();
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      merged.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

// Relative URLs are resolved against this origin when there is no page
// (Node, workers without a location), so dot segments ("..", "%2e%2e") and
// protocol-relative hosts are normalized exactly as fetch would resolve them.
// It is used only to classify a URL and is never dispatched. The reserved
// .invalid TLD never names a real FileFn deployment.
const NO_LOCATION_ORIGIN = "https://filefn-relative.invalid";

/**
 * A URL whose first two characters (ignoring the tab and newline characters
 * URL parsers strip) are slashes or backslashes names another host
 * ("//host/..." or "/\\host/..."), so it is never a path under baseUrl.
 */
function isProtocolRelative(url: string): boolean {
  return /^[/\\]{2}/.test(url.replace(/[\t\n\r]/g, ""));
}

/**
 * The base a browser resolves a relative fetch URL against: the document base
 * URL (which honors `<base href>`) in a window, else the location in a worker.
 * Undefined when there is neither (Node).
 */
function pageBaseUrl(): string | undefined {
  const baseURI = (globalThis as { document?: { baseURI?: unknown } }).document?.baseURI;
  if (typeof baseURI === "string") return baseURI;
  const href = globalThis.location?.href;
  return typeof href === "string" ? href : undefined;
}

function resolveUrl(url: string, base: string): URL | undefined {
  try {
    return new URL(url, base);
  } catch {
    return undefined;
  }
}

/**
 * Returns a function that resolves a part URL and tells whether it addresses
 * the FileFn API under `baseUrl` (same origin and path prefix). Only those
 * requests carry the configured auth headers and credentials mode.
 *
 * `baseUrl` and the part URL are resolved per call against one base, the one
 * the browser uses for fetch (see pageBaseUrl), and the returned `url` is the
 * resolved absolute URL, so the URL that is classified is exactly the URL
 * that is dispatched. Resolving also normalizes dot segments, so a path that
 * climbs out of baseUrl does not match. Without a page base, the URL is
 * classified against a placeholder origin and dispatched unchanged. An empty
 * `baseUrl` (a configured "" or "/") is the page origin root, so every
 * same-origin path matches it. A URL that cannot be parsed never matches.
 */
// FileFn's proxy part route, on the path under baseUrl.
const PART_ROUTE = /^\/upload\/[^/]+\/parts\/\d+$/;

function createPartUrlResolver(
  baseUrl: string,
): (url: string) => { url: string; toFileFn: boolean; toPartRoute: boolean; routePath: string | null } {
  return (url) => {
    const pageBase = pageBaseUrl();
    const base = resolveUrl(baseUrl || "/", pageBase ?? NO_LOCATION_ORIGIN);
    const target = resolveUrl(url, pageBase ?? NO_LOCATION_ORIGIN);
    if (!base || !target) return { url, toFileFn: false, toPartRoute: false, routePath: null };
    const basePath = base.pathname.replace(/\/$/, "");
    const toFileFn =
      target.origin === base.origin &&
      (target.pathname === basePath || target.pathname.startsWith(`${basePath}/`));
    return {
      url: pageBase ? target.href : url,
      toFileFn,
      // Only FileFn's own part endpoint, never another URL served under the
      // same origin and prefix (a presigned URL behind a reverse proxy).
      toPartRoute: toFileFn && !target.search && PART_ROUTE.test(target.pathname.slice(basePath.length)),
      routePath: toFileFn ? target.pathname.slice(basePath.length) : null,
    };
  };
}

/** A request body sent as is (artifact bytes) instead of as JSON. */
class RawBody {
  readonly data: Blob;

  constructor(data: Blob | Uint8Array) {
    // A Blob is resent unchanged by each retry and is a body every fetch accepts.
    this.data = data instanceof Uint8Array ? new Blob([data as BlobPart]) : data;
  }
}

export interface HttpClientOptions {
  /**
   * Runs right before every request is sent, retries included, after its auth
   * headers are resolved. A rejection stops the request: the offline queue
   * uses it to send nothing once the credentials act for another principal.
   */
  beforeSend?: () => Promise<void>;
  /**
   * Resolves the auth headers of each request, retries and part uploads
   * included, instead of `config.getAuthHeaders`. The offline queue uses it to
   * bind the credentials a replay sends to its partition's principal.
   */
  authHeaders?: () => Promise<Record<string, string> | undefined>;
}

export function createHttpClient(config: FileFnClientConfig, httpOptions: HttpClientOptions = {}): HttpClient {
  const retryOptions = resolveRetryOptions(config.retryOptions);
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const transport = resolveTransport(config);
  const resolvePartUrl = createPartUrlResolver(baseUrl);

  async function readResponseBody(response: Response): Promise<{
    rawBody: string;
    parsedBody: unknown;
    isJson: boolean;
  }> {
    if (typeof response.text === "function") {
      const rawBody = await response.text();
      if (!rawBody) {
        return { rawBody, parsedBody: undefined, isJson: false };
      }

      try {
        return { rawBody, parsedBody: JSON.parse(rawBody), isJson: true };
      } catch {
        if (typeof response.json === "function") {
          try {
            const parsedBody = await response.json();
            return { rawBody, parsedBody, isJson: true };
          } catch {
            // Fall back to the raw text body when a second parse is not possible.
          }
        }
        return { rawBody, parsedBody: rawBody, isJson: false };
      }
    }

    if (typeof response.json === "function") {
      const parsedBody = await response.json();
      return {
        rawBody: typeof parsedBody === "string" ? parsedBody : "",
        parsedBody,
        isJson: true,
      };
    }

    return { rawBody: "", parsedBody: undefined, isJson: false };
  }

  async function readAuthHeaders(): Promise<Record<string, string> | undefined> {
    if (httpOptions.authHeaders) return httpOptions.authHeaders();
    return config.getAuthHeaders ? await config.getAuthHeaders() : undefined;
  }

  /**
   * Turns one FileFn response into a `FileFnResult` (see there). `trusted`
   * is false when the request did not go to the verified FileFn route (a
   * part URL of another host or path): its error body is then never read as
   * a FileFn code. A redirected response proves nothing and is never coded.
   */
  async function decodeFileFnResult<T>(
    response: Response,
    schema: FileFnSchema<T>,
    trusted = true,
  ): Promise<FileFnResult<T>> {
    const redirected = response.redirected === true;
    if (!response.ok) {
      const { rawBody, parsedBody, isJson } = await readResponseBody(response).catch(() => ({
        rawBody: "",
        parsedBody: undefined,
        isJson: false,
      }));
      const body = rawBody ? (isJson ? parsedBody : rawBody) : parsedBody;
      const coded = trusted && !redirected && isErrorEnvelope(body);
      const error = new FileFnHttpError(
        `HTTP ${response.status}: ${response.statusText ?? ""}`.trim(),
        response.status,
        coded ? body : undefined,
      );
      return coded ? { kind: "refused", error } : { kind: "unknown", error };
    }
    if (redirected) {
      return { kind: "unknown", error: resultInvalid("A redirected answer proves nothing") };
    }
    const contentLength =
      typeof response.headers?.get === "function" ? response.headers.get("content-length") : null;
    if (response.status === 204 || contentLength === "0") return decodeFileFnBody(undefined, schema);
    const { rawBody, parsedBody, isJson } = await readResponseBody(response);
    if (rawBody && !isJson) {
      return { kind: "unknown", error: resultInvalid("The answer is not JSON") };
    }
    return decodeFileFnBody(parsedBody, schema);
  }

  /**
   * A request to the FileFn API. With `schema` (the upload-session routes),
   * the response goes through `decodeFileFnResult`: the decoded payload is
   * returned, a refusal or an unknown outcome is thrown. Without it (file,
   * artifact and render routes), a success envelope is unwrapped and any
   * other 2xx body is returned as it is.
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    options: ResolvedRetryOptions = retryOptions,
    extraHeaders?: Record<string, string>,
    schema?: FileFnSchema<T>,
  ): Promise<T> {
    return withRetry(
      async () => {
        const raw = body instanceof RawBody;
        const hasJsonBody = body !== undefined && !raw;
        const headers = mergeHeaders(
          await readAuthHeaders(),
          hasJsonBody ? { "Content-Type": "application/json" } : undefined,
          extraHeaders,
        );
        await httpOptions.beforeSend?.();
        const response = await transport.send(`${baseUrl}${path}`, {
          method,
          headers,
          body: raw ? body.data : body ? JSON.stringify(body) : undefined,
          credentials: transport.credentials,
          signal,
        });

        if (schema) {
          const decoded = await decodeFileFnResult(response, schema);
          if (decoded.kind === "ok") return decoded.data;
          throw decoded.error;
        }

        if (!response.ok) {
          const { rawBody, parsedBody, isJson } = await readResponseBody(response);
          const errorBody = rawBody ? (isJson ? parsedBody : rawBody) : parsedBody;
          throw new FileFnHttpError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
            errorBody,
          );
        }

        const contentLength =
          typeof response.headers?.get === "function"
            ? response.headers.get("content-length")
            : null;
        if (response.status === 204 || contentLength === '0') {
          return undefined as T;
        }

        const { rawBody, parsedBody, isJson } = await readResponseBody(response);
        if (!rawBody) {
          if (parsedBody === undefined) {
            return undefined as T;
          }
          if (!isJson) {
            return parsedBody as T;
          }
        }

        const json = parsedBody;

        // Unwrap canonical envelope { ok: true, data: T }
        if (
          json &&
          typeof json === "object" &&
          "ok" in json &&
          json.ok === true &&
          "data" in json
        ) {
          return json.data as T;
        }

        // If not a canonical envelope, return as-is for backwards compatibility
        return json as T;
      },
      options,
      signal,
    );
  }

  return {
    async initUpload(params, signal) {
      // The key travels in the x-idempotency-key header, the server's contract.
      // (0.4 and earlier sent it in the body, which servers before 0.8 ignored.)
      const { idempotencyKey, replayScope, ...body } = params;
      const headers: Record<string, string> = {};
      if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
      if (replayScope) headers["x-filefn-replay-scope"] = replayScope;
      return request<InitUploadResponse>(
        "POST",
        "/upload/init",
        body,
        signal,
        retryOptions,
        Object.keys(headers).length > 0 ? headers : undefined,
        uploadSchemas.init,
      );
    },

    async getFile(fileId, signal) {
      return request<Record<string, unknown>>(
        "GET",
        `/${fileId}`,
        undefined,
        signal,
      );
    },

    async getFileVersion(fileId, versionId, signal) {
      return request<Record<string, unknown>>(
        "GET",
        `/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`,
        undefined,
        signal,
        retryOptions,
        undefined,
        uploadSchemas.stored as unknown as FileFnSchema<Record<string, unknown>>,
      );
    },

    async listArtifacts(fileId, signal) {
      const response = await request<{ artifacts: ArtifactDescriptor[] }>(
        "GET",
        `/${fileId}/artifacts`,
        undefined,
        signal,
      );
      return response.artifacts;
    },

    async downloadUrl(fileId, options, signal) {
      const path = options?.versionId
        ? `/${fileId}/versions/${options.versionId}/download`
        : `/${fileId}/download`;
      return request<{ url: string }>("GET", path, undefined, signal);
    },

    async uploadArtifact(params, signal) {
      const search = params.durationMs !== undefined
        ? `?${new URLSearchParams({ durationMs: String(params.durationMs) }).toString()}`
        : "";
      const path =
        `/${encodeURIComponent(params.fileId)}/versions/${encodeURIComponent(params.versionId)}` +
        `/artifacts/${encodeURIComponent(params.kind)}${search}`;
      // PUT replaces the same artifact record, so a retried upload is safe.
      const response = await request<{ artifact: ArtifactDescriptor }>(
        "PUT",
        path,
        new RawBody(params.data),
        signal,
        retryOptions,
        { "Content-Type": params.mimeType },
      );
      return response.artifact;
    },

    async downloadArtifact(fileId, artifactId, signal) {
      return request<{ url: string; headers?: Record<string, string> }>(
        "GET",
        `/${fileId}/artifacts/${artifactId}/download`,
        undefined,
        signal,
      );
    },

    async getRenderDescriptor(fileId, options, signal) {
      const search = new URLSearchParams({ intent: options.intent });
      if (options.versionId) {
        search.set("versionId", options.versionId);
      }
      return request<RenderDescriptor>(
        "GET",
        `/${fileId}/render?${search.toString()}`,
        undefined,
        signal,
      );
    },

    async deleteFile(fileId, signal) {
      await request<void>("DELETE", `/${fileId}`, undefined, signal);
    },

    async getUploadStatus(uploadSessionId, uploadSessionToken, signal) {
      return request<UploadStatusResponse>(
        "GET",
        `/upload/${encodeURIComponent(uploadSessionId)}/status`,
        undefined,
        signal,
        retryOptions,
        uploadSessionToken ? { "x-upload-session-token": uploadSessionToken } : undefined,
        uploadSchemas.status,
      );
    },

    async signPart(uploadSessionId, partNumber, contentLength, uploadSessionToken, signal) {
      return request<SignPartResponse>(
        "POST",
        `/upload/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}/sign`,
        { contentLength },
        signal,
        retryOptions,
        uploadSessionToken ? { "x-upload-session-token": uploadSessionToken } : undefined,
        uploadSchemas.sign,
      );
    },

    async completePart(uploadSessionId, partNumber, etag, size, uploadSessionToken, signal) {
      return request<CompletePartResponse>(
        "POST",
        `/upload/${encodeURIComponent(uploadSessionId)}/parts/${partNumber}/complete`,
        { etag, size },
        signal,
        retryOptions,
        uploadSessionToken ? { "x-upload-session-token": uploadSessionToken } : undefined,
        uploadSchemas.ack<CompletePartResponse>,
      );
    },

    async completeUpload(uploadSessionId, uploadSessionToken, signal) {
      return request<CompleteUploadResponse>(
        "POST",
        `/upload/${encodeURIComponent(uploadSessionId)}/complete`,
        undefined,
        signal,
        retryOptions,
        uploadSessionToken ? { "x-upload-session-token": uploadSessionToken } : undefined,
        uploadSchemas.stored,
      );
    },

    async abortUpload(uploadSessionId, uploadSessionToken, signal) {
      return request<AbortUploadResponse>(
        "POST",
        `/upload/${encodeURIComponent(uploadSessionId)}/abort`,
        undefined,
        signal,
        retryOptions,
        uploadSessionToken ? { "x-upload-session-token": uploadSessionToken } : undefined,
        uploadSchemas.ack<AbortUploadResponse>,
      );
    },

    async uploadPartToSignedUrl(url, headers, body, uploadSessionToken, signal, expectedPart) {
      return withRetry(
        async () => {
          // A root-relative URL (proxy upload) is a path under baseUrl; a
          // protocol-relative URL names its own host and is never prefixed.
          // Proxy uploads under baseUrl go to FileFn and carry its auth
          // headers and credentials mode. Any other URL (a presigned storage
          // URL) gets only its signed headers and never ambient credentials.
          // The URL is classified and dispatched in the same resolved form.
          const { url: finalUrl, toFileFn, toPartRoute, routePath } = resolvePartUrl(
            url.startsWith("/") && !isProtocolRelative(url) ? `${baseUrl}${url}` : url,
          );

          // The session token is FileFn's credential: it goes only to FileFn's
          // part endpoint, never to a storage provider's presigned URL, whose
          // logs would record it. A token-bearing PUT follows no redirect, so a
          // redirect can't carry the header elsewhere.
          // Proxy part URLs are issued root-relative (`/upload/<id>/parts/<n>`);
          // storage URLs, multipart included, are absolute. Only a root-relative
          // URL that resolves to the part route gets the token, so a storage
          // URL never does, whatever path a same-origin storage proxy uses.
          // When the caller names the part, only FileFn's exact endpoint for
          // that session and part qualifies.
          const issuedRelative = url.startsWith("/") && !isProtocolRelative(url);
          const exactPart =
            !expectedPart ||
            routePath === `/upload/${encodeURIComponent(expectedPart.uploadSessionId)}/parts/${expectedPart.partNumber}`;
          const partRequest = issuedRelative && toPartRoute && exactPart;
          const requestHeaders = mergeHeaders(
            toFileFn ? await readAuthHeaders() : undefined,
            headers,
          );
          // The token goes only to a verified FileFn part request: the explicit
          // one first, else one the auth headers carry (a resumed upload). It is
          // removed from every other request.
          let headerToken: string | undefined;
          for (const name of Object.keys(requestHeaders)) {
            if (name.toLowerCase() === "x-upload-session-token") {
              headerToken = requestHeaders[name];
              delete requestHeaders[name];
            }
          }
          const token = uploadSessionToken || headerToken;
          const sendToken = partRequest && Boolean(token);
          if (sendToken) requestHeaders["x-upload-session-token"] = token!;
          await httpOptions.beforeSend?.();
          const response = await transport.send(finalUrl, {
            method: "PUT",
            headers: requestHeaders,
            body,
            credentials: toFileFn ? transport.credentials : "omit",
            // FileFn's verified part route is never followed elsewhere: a
            // redirect fails the request (a network error, retried), so no
            // other host's answer is read as FileFn's.
            ...(partRequest ? { redirect: "error" as const } : {}),
            signal,
          });

          // Only FileFn's verified part route answers with a coded refusal
          // (a retryable conflict, an ended session). Any other URL, a
          // same-origin signed storage URL included, and any redirected
          // answer stay an uncoded HTTP error: never a FileFn code.
          const contentType =
            typeof response.headers?.get === "function" ? response.headers.get("content-type") : null;
          if (!response.ok || (contentType && contentType.includes("application/json"))) {
            const decoded = await decodeFileFnResult(response, uploadSchemas.part, partRequest);
            if (decoded.kind !== "ok") throw decoded.error;
            return { etag: decoded.data.etag || "", recorded: decoded.data.recorded };
          }
          if (response.redirected === true) throw resultInvalid("A redirected part upload proves nothing");

          return { etag: response.headers.get("ETag") || "" };
        },
        retryOptions,
        signal,
      );
    },
  };
}
