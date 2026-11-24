import { bodyTooLarge, invalidRequest, unsupportedMediaType } from './errors.js';

/** Largest JSON request body FileFn reads (upload init metadata is capped lower). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

// RFC 9110 media type: type "/" subtype, both tokens.
const MEDIA_TYPE = /^([!#$%&'*+.^_`|~0-9a-z-]+)\/([!#$%&'*+.^_`|~0-9a-z-]+)$/;

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const match = MEDIA_TYPE.exec(contentType.split(';', 1)[0].trim().toLowerCase());
  if (!match || match[1] !== 'application') return false;
  return match[2] === 'json' || (match[2].endsWith('+json') && match[2].length > '+json'.length);
}

/**
 * Reads a JSON request body. Only `application/json` (or `+json`) is accepted:
 * a cross-site HTML form or a `no-cors` fetch can only send "simple" content
 * types (text/plain, form encodings), so a JSON-only route is never reached
 * by one without a CORS preflight, even when auth is a cookie. Bodies over
 * MAX_JSON_BODY_BYTES are refused.
 */
export async function readJsonBody<T>(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<T> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw unsupportedMediaType();
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw bodyTooLarge(maxBytes);
  }
  const text = await readTextBounded(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalidRequest('Request body must be valid JSON');
  }
}

async function readTextBounded(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: a body whose source never settles must not hold back the 413.
      void reader.cancel().catch(() => {});
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
