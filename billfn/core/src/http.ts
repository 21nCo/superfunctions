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
 * catalog price ids). They stay on the thrown error itself; the response leaves them out.
 */
const PRIVATE_DETAIL_KEYS: ReadonlySet<string> = new Set(['body', 'raw', 'rawBody', 'bundleIds', 'matchingPriceIds']);

/** The error details safe to return over HTTP: a plain object without the private keys, at any depth. */
export function publicErrorDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  let kept: Record<string, unknown> | undefined;
  try {
    kept = stripPrivateDetails(details) as Record<string, unknown> | undefined;
  } catch {
    // Details that cannot be read safely (a throwing getter) are left out; the error itself is still answered.
    return undefined;
  }
  return kept && Object.keys(kept).length > 0 ? kept : undefined;
}

function stripPrivateDetails(value: unknown, depth = 0): unknown {
  if (value === null) {
    return value;
  }
  // A bigint cannot be serialized, and a symbol or function (which may carry its own toJSON) is not data.
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return undefined;
  }
  if (typeof value !== 'object') {
    return value;
  }
  // Details are small; anything nested deeper than this is not returned at all.
  if (depth >= 8) {
    return undefined;
  }
  // Only plain data is rebuilt: a plain array, or an object whose prototype is Object.prototype or null. Anything
  // else (a class instance, an Array subclass, a Date, an Error) is left out rather than serialized from its own
  // properties, and so is plain data with its own serializer (even a non-enumerable toJSON), which decides what
  // it shows.
  const prototype = Object.getPrototypeOf(value);
  const plain = Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
  // Plain data inherits nothing but Object.prototype or Array.prototype, so its own `toJSON` (value or accessor) is
  // the only one; it is found by descriptor, never read.
  if (!plain || Object.getOwnPropertyDescriptor(value, 'toJSON') !== undefined) {
    return undefined;
  }
  // Left-out values are dropped (array items and object keys alike), and an array or object that held something but
  // is left with nothing is left out in turn, so details made only of left-out values, at any depth, answer as none.
  if (Array.isArray(value)) {
    // Walked by index into a new array, never through the input's own methods (an own `map` could replace them).
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = stripPrivateDetails(value[index], depth + 1);
      if (item !== undefined) {
        items.push(item);
      }
    }
    return items.length > 0 || value.length === 0 ? items : undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries
    .filter(([key]) => !PRIVATE_DETAIL_KEYS.has(key))
    .map(([key, item]) => [key, stripPrivateDetails(item, depth + 1)] as const)
    .filter(([, item]) => item !== undefined);
  return kept.length > 0 || entries.length === 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Reads a request body as bytes, up to `limit`: a larger body (declared by content-length, or found while reading)
 * answers 'too_large' without reading the rest, and a body something else already started reading answers
 * 'already_read' (its remainder is not the request's body). The stream is released, not cancelled, so neither an
 * unread clone of the request nor the host's transport holds the answer back.
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
      // Stop reading without cancelling the body: cancelling a bridged Node stream (Readable.toWeb) destroys the
      // socket before the host can send the 400. The host drains or closes the connection.
      try {
        reader.releaseLock();
      } catch {
        // A pending read keeps the lock; nothing more is read either way.
      }
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
