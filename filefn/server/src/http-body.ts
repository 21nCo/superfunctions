import { bodyTooLarge, invalidRequest, unsupportedMediaType } from './errors.js';

/** Largest JSON request body FileFn reads (upload init metadata is capped lower). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const essence = contentType.split(';', 1)[0].trim().toLowerCase();
  return essence === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(essence);
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
      await reader.cancel().catch(() => {});
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
