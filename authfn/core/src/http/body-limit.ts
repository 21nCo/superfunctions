import { AuthFnPayloadTooLargeError } from '../core/errors.js';

/** Maximum body size for AuthFn routes that use the router's body limit. */
export const AUTHFN_MAX_BODY_BYTES = 64 * 1024;

/** Checks a clone so hosts and handlers keep the original Request and its native body readers. */
export async function assertAuthRequestBodyLimit(request: Request): Promise<void> {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > AUTHFN_MAX_BODY_BYTES) {
    cancel(request.body);
    throw new AuthFnPayloadTooLargeError(AUTHFN_MAX_BODY_BYTES);
  }

  if (!request.body || request.bodyUsed) return;
  const reader = request.clone().body!.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > AUTHFN_MAX_BODY_BYTES) {
        // At this point both tee branches must be cancelled. Do not await a
        // stream source's cancellation handler before returning the 413.
        void reader.cancel().catch(() => undefined);
        cancel(request.body);
        throw new AuthFnPayloadTooLargeError(AUTHFN_MAX_BODY_BYTES);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => undefined);
}
