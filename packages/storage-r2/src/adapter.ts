import {
  assertMultipartParts,
  assertValidSignedUrlExpiry,
  createNotFoundError,
  createStorageError,
} from '@superfunctions/storage/internal/errors';
import type {
  SignedUrlConstraints,
  StorageAdapter,
  StorageAdapterCapabilities,
  StorageObjectStat,
} from '@superfunctions/storage';
import {
  encodeRfc3986,
  encodeS3Key,
  presignUrl,
  sha256Hex,
  signRequest,
  type SigV4Credentials,
  type SigV4Scope,
} from './sigv4.js';

export type R2Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface R2StorageConfig {
  /** Cloudflare account ID; selects `https://<accountId>[.<jurisdiction>].r2.cloudflarestorage.com`. */
  accountId: string;
  bucket: string;
  /** R2 S3-API token access key ID. */
  accessKeyId: string;
  /** R2 S3-API token secret access key. */
  secretAccessKey: string;
  jurisdiction?: 'eu' | 'fedramp';
  /**
   * Override the S3 API endpoint (for example a local S3-compatible server in
   * tests). Requests use path-style addressing: `<endpoint>/<bucket>/<key>`.
   */
  endpoint?: string;
  /** SigV4 signing region. R2 uses `auto`. */
  region?: string;
  /** Custom fetch implementation. Defaults to the global `fetch`, resolved per call. */
  fetch?: R2Fetch;
  /** Retry policy for transient failures. Defaults to 3 attempts. */
  retry?: R2RetryOptions;
}

/**
 * Bounded retry for transient failures: network errors (including a response
 * body that fails mid-read), HTTP 5xx and 429, S3 throttling and timeout error
 * codes, and a completion that reports such an error inside a 200 response.
 * Each attempt is signed afresh. Delays use full jitter: a random wait up to
 * `baseDelayMs * 2^(attempt - 1)` (five times the base for 429 and 503),
 * capped at `maxDelayMs`.
 */
export interface R2RetryOptions {
  /** Total attempts per request, including the first. Defaults to 3; 1 disables retries. */
  maxAttempts?: number;
  /** Defaults to 100 ms. */
  baseDelayMs?: number;
  /** Defaults to 20 000 ms. */
  maxDelayMs?: number;
}

/**
 * An S3 API error response. `name` is the S3 error code when the response
 * carried one (for example `NoSuchUpload`), and the HTTP status is exposed as
 * both `statusCode` and `$metadata.httpStatusCode` like AWS SDK errors.
 */
export class R2RequestError extends Error {
  readonly statusCode: number;
  readonly $metadata: { httpStatusCode: number; requestId?: string };

  constructor(operation: string, statusCode: number, s3Code?: string, s3Message?: string, requestId?: string) {
    const code = s3Code ? ' ' + s3Code : '';
    const detail = s3Message ? ': ' + s3Message : '';
    super(`R2 ${operation} failed with HTTP ${statusCode}${code}${detail}`);
    this.name = s3Code ?? 'R2RequestError';
    this.statusCode = statusCode;
    this.$metadata = { httpStatusCode: statusCode, requestId };
  }
}

const CAPABILITIES: StorageAdapterCapabilities = {
  signedUploadUrls: true,
  signedDownloadUrls: true,
  multipart: true,
  proxyStreamingUpload: false,
  proxyStreamingDownload: true,
};

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = hex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

// An optional namespace prefix (`s3:`) before an element name.
const XML_PREFIX = String.raw`(?:[A-Za-z_][\w.-]*:)?`;

/** Text of the first `name` element, whatever its namespace prefix or attributes. */
function xmlElement(xml: string, name: string): string | undefined {
  const match = new RegExp(String.raw`<${XML_PREFIX}${name}(?:\s[^>]*)?>([\s\S]*?)</${XML_PREFIX}${name}\s*>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

/** Local name of the document's root element, without its namespace prefix. */
function xmlRootName(xml: string): string | undefined {
  // Skip a BOM, the XML declaration, processing instructions, comments, a
  // doctype and whitespace (S3 pads slow completions with spaces).
  const body = xml.replace(/^\uFEFF?(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
  return /^<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s/>]/.exec(body)?.[1];
}

// S3 error codes worth retrying whatever the HTTP status (the SDK's throttling
// and transient codes, plus the server-side codes S3 can embed in a 200).
const RETRYABLE_CODES = new Set([
  'InternalError',
  'ServiceUnavailable',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'RequestLimitExceeded',
  'TooManyRequests',
  'TooManyRequestsException',
  'RequestTimeout',
  'RequestTimeoutException',
]);

function resolveRetry(options: R2RetryOptions | undefined): Required<R2RetryOptions> {
  // Per-field defaults, so an explicit `undefined` still means "use the default".
  const retry = {
    maxAttempts: options?.maxAttempts ?? 3,
    baseDelayMs: options?.baseDelayMs ?? 100,
    maxDelayMs: options?.maxDelayMs ?? 20_000,
  };
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw createStorageError('R2 retry.maxAttempts must be a positive integer', 'STORAGE_CONFIG_INVALID');
  }
  for (const field of ['baseDelayMs', 'maxDelayMs'] as const) {
    if (!Number.isFinite(retry[field]) || retry[field] < 0) {
      throw createStorageError(`R2 retry.${field} must be a non-negative number`, 'STORAGE_CONFIG_INVALID');
    }
  }
  return retry;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

function resolveEndpoint(config: R2StorageConfig): string {
  if (config.endpoint) {
    const url = new URL(config.endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw createStorageError('R2 endpoint must be an http(s) URL', 'STORAGE_CONFIG_INVALID');
    }
    return `${url.origin}${trimTrailingSlashes(url.pathname)}`;
  }
  if (!/^[A-Za-z0-9-]+$/.test(config.accountId ?? '')) {
    throw createStorageError('R2 accountId must be a non-empty account ID', 'STORAGE_CONFIG_INVALID');
  }
  return config.jurisdiction
    ? `https://${config.accountId}.${config.jurisdiction}.r2.cloudflarestorage.com`
    : `https://${config.accountId}.r2.cloudflarestorage.com`;
}

function assertValidKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw createStorageError('Object key must be a non-empty string', 'STORAGE_KEY_INVALID');
  }
  // fetch() resolves `.` and `..` path segments (even percent-encoded ones), so
  // such a key would address a different object than the one that was signed.
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw createStorageError('Object key must not contain "." or ".." path segments', 'STORAGE_KEY_INVALID');
  }
  try {
    return encodeS3Key(key);
  } catch {
    throw createStorageError('Object key must be valid Unicode', 'STORAGE_KEY_INVALID');
  }
}

function emptyStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Cloudflare R2 storage adapter over R2's S3-compatible API. Uses only `fetch`
 * and Web Crypto (no AWS SDK), so it runs on Cloudflare Workers as well as
 * Node.js 20+. Requests and presigned URLs are signed with SigV4.
 */
export function createR2StorageAdapter(config: R2StorageConfig): StorageAdapter {
  for (const field of ['bucket', 'accessKeyId', 'secretAccessKey'] as const) {
    if (typeof config[field] !== 'string' || config[field].length === 0) {
      throw createStorageError(`R2 ${field} is required`, 'STORAGE_CONFIG_INVALID');
    }
  }
  const baseUrl = `${resolveEndpoint(config)}/${encodeRfc3986(config.bucket)}`;
  const credentials: SigV4Credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  const scope: SigV4Scope = { region: config.region ?? 'auto', service: 's3' };
  const doFetch: R2Fetch = config.fetch ?? ((input, init) => fetch(input, init));
  const retry = resolveRetry(config.retry);

  function objectUrl(key: string, query: Array<[string, string]> = []): string {
    const path = `${baseUrl}/${assertValidKey(key)}`;
    if (query.length === 0) return path;
    return `${path}?${query
      .map(([name, value]) => (value === '' ? encodeRfc3986(name) : `${encodeRfc3986(name)}=${encodeRfc3986(value)}`))
      .join('&')}`;
  }

  function toError(operation: string, response: Response, text: string): R2RequestError {
    return new R2RequestError(
      operation,
      response.status,
      xmlElement(text, 'Code'),
      xmlElement(text, 'Message'),
      response.headers.get('x-amz-request-id') ?? xmlElement(text, 'RequestId')
    );
  }

  interface SendOptions {
    headers?: Record<string, string>;
    body?: string;
    /** Read a successful response's body inside the retry loop and return it as `text`. */
    readBody?: boolean;
    /** Also retry a 200 whose body is an S3 error document with a retryable code. Implies `readBody`. */
    inspectOkBody?: boolean;
  }

  interface SendResult {
    response: Response;
    /**
     * The body, read inside the retry loop. Set for every non-2xx response and
     * for a 2xx response when `readBody` or `inspectOkBody` is set; otherwise
     * the body is left unread for the caller.
     */
    text?: string;
  }

  function isRetryable(response: Response, text: string | undefined, inspectOkBody: boolean): boolean {
    if (response.status >= 500 || response.status === 429) return true;
    if (response.ok ? !inspectOkBody : response.status === 404) return false;
    const body = text ?? '';
    if (response.ok && xmlRootName(body) !== 'Error') return false;
    return RETRYABLE_CODES.has(xmlElement(body, 'Code') ?? '');
  }

  function backoff(attempt: number, status?: number): Promise<void> {
    const base = status === 429 || status === 503 ? retry.baseDelayMs * 5 : retry.baseDelayMs;
    const delay = Math.random() * Math.min(retry.maxDelayMs, base * 2 ** (attempt - 1));
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Sign and send a request, retrying transient failures. Every part of the
   * response the adapter consumes itself (status, headers, and the body of an
   * error or of a `readBody` request) is read inside the loop, so a connection
   * that drops while a body is streaming is retried like any network error.
   * Only a successful response whose body belongs to the caller leaves the
   * loop unread. Returns the first non-retryable response, or the last one
   * once attempts run out; a transport failure on the last attempt, or any
   * abort, is thrown.
   */
  async function send(method: string, url: string, options: SendOptions = {}): Promise<SendResult> {
    const payloadHash = options.body === undefined ? undefined : await sha256Hex(options.body);
    const inspectOkBody = options.inspectOkBody ?? false;
    const readOkBody = inspectOkBody || (options.readBody ?? false);
    for (let attempt = 1; ; attempt += 1) {
      const lastAttempt = attempt >= retry.maxAttempts;
      // Sign each attempt so a retry after a long backoff carries a fresh date.
      const headers = await signRequest(credentials, scope, { method, url, headers: options.headers, payloadHash });
      let response: Response;
      let text: string | undefined;
      try {
        response = await doFetch(url, { method, headers, body: options.body });
        // Error documents and the results the adapter parses are small.
        if (readOkBody || !response.ok) text = await response.text();
      } catch (error) {
        if (lastAttempt || isAbortError(error)) throw error;
        await backoff(attempt);
        continue;
      }
      if (lastAttempt || !isRetryable(response, text, inspectOkBody)) {
        return { response, text };
      }
      await backoff(attempt, response.status);
    }
  }

  async function sendOk(operation: string, method: string, url: string, options?: SendOptions): Promise<SendResult> {
    const result = await send(method, url, options);
    if (!result.response.ok) {
      throw toError(operation, result.response, result.text ?? '');
    }
    return result;
  }

  async function presign(
    method: string,
    url: string,
    expiresInSeconds: number,
    headers?: Record<string, string>
  ): Promise<string> {
    assertValidSignedUrlExpiry(expiresInSeconds);
    return presignUrl(credentials, scope, { method, url, headers, expiresInSeconds });
  }

  function constraintHeaders(constraints: SignedUrlConstraints | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    if (constraints?.contentType) headers['content-type'] = constraints.contentType;
    if (constraints?.contentLength !== undefined) headers['content-length'] = String(constraints.contentLength);
    return headers;
  }

  return {
    name: 'r2',
    capabilities: { ...CAPABILITIES },

    async statObject(input: { key: string }): Promise<StorageObjectStat> {
      const { response, text } = await send('HEAD', objectUrl(input.key));
      if (response.status === 404) {
        throw createNotFoundError();
      }
      if (!response.ok) {
        throw toError('HeadObject', response, text ?? '');
      }
      const lastModified = response.headers.get('last-modified');
      const lastModifiedDate = lastModified ? new Date(lastModified) : undefined;
      return {
        key: input.key,
        size: Number(response.headers.get('content-length') ?? 0),
        contentType: response.headers.get('content-type') ?? undefined,
        etag: response.headers.get('etag') ?? undefined,
        lastModifiedAt:
          lastModifiedDate && !Number.isNaN(lastModifiedDate.getTime()) ? lastModifiedDate.toISOString() : undefined,
      };
    },

    async deleteObject(input: { key: string }): Promise<void> {
      const { response } = await sendOk('DeleteObject', 'DELETE', objectUrl(input.key));
      await response.body?.cancel();
    },

    async signUploadUrl(input: {
      key: string;
      expiresInSeconds: number;
      constraints?: SignedUrlConstraints;
    }): Promise<{ url: string; headers?: Record<string, string> }> {
      const url = await presign(
        'PUT',
        objectUrl(input.key),
        input.expiresInSeconds,
        constraintHeaders(input.constraints)
      );
      return input.constraints?.contentType
        ? { url, headers: { 'Content-Type': input.constraints.contentType } }
        : { url };
    },

    async signDownloadUrl(input: {
      key: string;
      expiresInSeconds: number;
      constraints?: { responseContentType?: string };
    }): Promise<{ url: string; headers?: Record<string, string> }> {
      const query: Array<[string, string]> = input.constraints?.responseContentType
        ? [['response-content-type', input.constraints.responseContentType]]
        : [];
      return { url: await presign('GET', objectUrl(input.key, query), input.expiresInSeconds) };
    },

    async createMultipartUpload(input: {
      key: string;
      contentType?: string;
      metadata?: Record<string, string>;
    }): Promise<{ uploadId: string }> {
      const headers: Record<string, string> = {};
      if (input.contentType) headers['content-type'] = input.contentType;
      for (const [name, value] of Object.entries(input.metadata ?? {})) {
        headers[`x-amz-meta-${name.toLowerCase()}`] = value;
      }
      const { response, text = '' } = await sendOk(
        'CreateMultipartUpload',
        'POST',
        objectUrl(input.key, [['uploads', '']]),
        { headers, readBody: true }
      );
      if (xmlRootName(text) === 'Error') {
        throw toError('CreateMultipartUpload', response, text);
      }
      const uploadId = xmlElement(text, 'UploadId');
      if (!uploadId) {
        throw new R2RequestError(
          'CreateMultipartUpload',
          response.status,
          undefined,
          'response has no UploadId',
          response.headers.get('x-amz-request-id') ?? undefined
        );
      }
      return { uploadId };
    },

    async signMultipartUploadPartUrl(input: {
      key: string;
      uploadId: string;
      partNumber: number;
      expiresInSeconds: number;
      constraints?: SignedUrlConstraints;
    }): Promise<{ url: string; headers?: Record<string, string> }> {
      const headers: Record<string, string> = {};
      if (input.constraints?.contentLength !== undefined) {
        headers['content-length'] = String(input.constraints.contentLength);
      }
      const url = await presign(
        'PUT',
        objectUrl(input.key, [
          ['partNumber', String(input.partNumber)],
          ['uploadId', input.uploadId],
        ]),
        input.expiresInSeconds,
        headers
      );
      return { url };
    },

    async completeMultipartUpload(input: {
      key: string;
      uploadId: string;
      parts: Array<{ partNumber: number; etag: string }>;
    }): Promise<void> {
      assertMultipartParts(input.parts);
      const body =
        '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        [...input.parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
          .join('') +
        '</CompleteMultipartUpload>';
      const { response, text = '' } = await sendOk(
        'CompleteMultipartUpload',
        'POST',
        objectUrl(input.key, [['uploadId', input.uploadId]]),
        { headers: { 'content-type': 'application/xml' }, body, inspectOkBody: true }
      );
      // S3 can report a failed completion inside a 200 response, so only a
      // CompleteMultipartUploadResult document counts as success.
      if (xmlRootName(text) !== 'CompleteMultipartUploadResult') {
        const code = xmlElement(text, 'Code');
        throw new R2RequestError(
          'CompleteMultipartUpload',
          response.status,
          code,
          xmlElement(text, 'Message') ?? (code ? undefined : 'response is not a CompleteMultipartUploadResult'),
          response.headers.get('x-amz-request-id') ?? xmlElement(text, 'RequestId')
        );
      }
    },

    async abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void> {
      const { response } = await sendOk(
        'AbortMultipartUpload',
        'DELETE',
        objectUrl(input.key, [['uploadId', input.uploadId]])
      );
      await response.body?.cancel();
    },

    async openDownloadStream(input: {
      key: string;
      range?: { start: number; endInclusive: number };
    }): Promise<ReadableStream> {
      const headers: Record<string, string> = {};
      if (input.range) headers.range = `bytes=${input.range.start}-${input.range.endInclusive}`;
      // Ask for the stored bytes as-is. An object uploaded with a
      // Content-Encoding (for example gzip) would otherwise be decoded by
      // fetch, so the stream would not match the stored size or byte ranges.
      const { response, text } = await send(
        'GET',
        objectUrl(input.key, [['response-content-encoding', 'identity']]),
        { headers }
      );
      if (response.status === 404) {
        throw createNotFoundError();
      }
      if (!response.ok) {
        throw toError('GetObject', response, text ?? '');
      }
      return response.body ?? emptyStream();
    },
  };
}
