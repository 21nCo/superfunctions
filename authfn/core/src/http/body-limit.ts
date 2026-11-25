import { AuthFnPayloadTooLargeError } from '../core/errors.js';

/**
 * Largest request body the auth router will read. Sign-up profiles are capped
 * at 4 KiB and passwords at 1 KiB, so 64 KiB covers those JSON bodies and the
 * OAuth routes that document the same ceiling. A larger body is rejected
 * before rate limiting, placement, or route parsing.
 */
export const AUTHFN_MAX_BODY_BYTES = 64 * 1024;

const BODY_CANCEL_DEADLINE_MS = 50;
const loadedBodies = new WeakMap<BoundedBodyRequest, Promise<Uint8Array>>();

/**
 * Auth routes read `request.json()`, `request.text()`, `request.formData()`
 * and `request.arrayBuffer()` directly. The shared router's `maxBodyBytes`
 * only limits route-context readers, so this wrapper bounds those methods.
 * Routes that read `request.body` themselves keep their own caps and timeouts.
 */
export function boundAuthRequest(request: Request): Request {
  if (request instanceof BoundedBodyRequest) {
    return request;
  }
  return new BoundedBodyRequest(request);
}

class BoundedBodyRequest extends Request {
  override text(): Promise<string> {
    return loadBoundedBody(this).then((bytes) => new TextDecoder().decode(bytes));
  }

  override json(): Promise<unknown> {
    return this.text().then((text) => JSON.parse(text) as unknown);
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return loadBoundedBody(this).then((bytes) => copyBytes(bytes).buffer);
  }

  override blob(): Promise<Blob> {
    return loadBoundedBody(this).then((bytes) => new Blob([copyBytes(bytes)]));
  }

  override formData(): Promise<FormData> {
    return loadBoundedBody(this).then((bytes) =>
      new Response(copyBytes(bytes), { headers: this.headers }).formData()
    );
  }

  override clone(): BoundedBodyRequest {
    return new BoundedBodyRequest(super.clone());
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function loadBoundedBody(request: BoundedBodyRequest): Promise<Uint8Array> {
  let pending = loadedBodies.get(request);
  if (!pending) {
    pending = readBoundedBody(request, AUTHFN_MAX_BODY_BYTES);
    loadedBodies.set(request, pending);
  }
  return pending;
}

/**
 * Reads a body up to `maxBodyBytes`. A declared Content-Length over the limit
 * is rejected without reading. A stream with no Content-Length is rejected as
 * soon as the accumulated bytes pass the limit, and the unread remainder is
 * cancelled.
 */
async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      await cancelStream(request.body);
      throw new AuthFnPayloadTooLargeError(maxBodyBytes);
    }
  }

  const body = request.body;
  // A null body is empty. Do not call arrayBuffer(): this request's override
  // reads through here, and that call would recurse.
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await cancelReader(reader);
        throw new AuthFnPayloadTooLargeError(maxBodyBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation already released the reader.
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function cancelStream(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) {
    return;
  }
  await withCancelDeadline(stream.cancel('PAYLOAD_TOO_LARGE'));
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await withCancelDeadline(reader.cancel('PAYLOAD_TOO_LARGE'));
}

async function withCancelDeadline(cancelled: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancelled.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BODY_CANCEL_DEADLINE_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
