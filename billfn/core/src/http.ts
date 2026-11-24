import { err, ok, type Envelope } from '@superfunctions/envelope';
import type { SuperfunctionError } from '@superfunctions/errors';

export function jsonResponse<T>(body: Envelope<T>, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

export function successResponse<T>(data: T, status: number = 200): Response {
  return jsonResponse(ok(data), status);
}

/**
 * Error detail keys never returned to a caller: a provider's raw response body and configuration (bundle ids,
 * catalog price ids). They stay on the thrown error for the host's logs.
 */
const PRIVATE_DETAIL_KEYS: ReadonlySet<string> = new Set(['body', 'raw', 'rawBody', 'bundleIds', 'matchingPriceIds']);

/** The error details safe to return over HTTP: a plain object without the private keys, at any depth. */
export function publicErrorDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  const kept = stripPrivateDetails(details) as Record<string, unknown> | undefined;
  return kept && Object.keys(kept).length > 0 ? kept : undefined;
}

function stripPrivateDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Only plain data is rebuilt; another object (a class instance with its own toJSON, a Date, an Error) is left out
  // rather than serialized from its own properties.
  const prototype = Array.isArray(value) ? Array.prototype : Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  // Details are small; anything nested deeper than this is not returned at all.
  if (depth >= 8) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivateDetails(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PRIVATE_DETAIL_KEYS.has(key))
      .map(([key, item]) => [key, stripPrivateDetails(item, depth + 1)])
  );
}

/**
 * Reads a request body as bytes, up to `limit`: a larger body (declared by content-length, or found while reading)
 * answers 'too_large' without reading the rest, and a body something else already started reading answers
 * 'already_read' (its remainder is not the request's body). The stream is cancelled without waiting, so an unread
 * clone of the request cannot hold the answer back.
 */
export async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array | 'too_large' | 'already_read'> {
  if (request.bodyUsed) {
    return 'already_read';
  }
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    return 'too_large';
  }
  if (!request.body) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function errorResponse(error: Error): Response {
  if (isSuperfunctionError(error)) {
    return jsonResponse(
      err({
        code: error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable,
        details: publicErrorDetails(error.details)
      }),
      error.status
    );
  }

  return jsonResponse(
    err({
      code: 'BILLFN_INTERNAL_ERROR',
      message: 'Unexpected billfn error',
      status: 500,
      retryable: false
    }),
    500
  );
}

function isSuperfunctionError(value: Error): value is SuperfunctionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  );
}
