import { AuthFnError, AuthFnPayloadTooLargeError } from '../core/errors.js';

/** Maximum body size for AuthFn routes that use the router's body limit. */
export const AUTHFN_MAX_BODY_BYTES = 64 * 1024;
const AUTHFN_BODY_READ_TIMEOUT_MS = 5_000;

/** The released OAuth provider's routes with protocol-specific body readers. */
export function getOAuthBodyPolicy(path: string) {
  if (path === '/oauth/register') {
    return {
      operationId: 'oauthRegister',
      errorCode: 'invalid_client_metadata',
      sizeError: 'Request body must be a JSON object of at most 64 KB'
    };
  }
  if (path === '/oauth/device_authorization') {
    return {
      operationId: 'oauthDeviceAuthorization',
      errorCode: 'invalid_request',
      sizeError: 'Request body must be at most 8 KB'
    };
  }
  return undefined;
}

/** Checks a clone so hosts and handlers keep the original Request and its native body readers. */
export async function assertAuthRequestBodyLimit(request: Request): Promise<void> {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > AUTHFN_MAX_BODY_BYTES) {
    cancel(request.body);
    throw new AuthFnPayloadTooLargeError(AUTHFN_MAX_BODY_BYTES);
  }

  if (!request.body || request.bodyUsed) return;
  const { signal } = request;
  if (signal.aborted) {
    cancel(request.body);
    throw canceledBodyError();
  }
  const reader = request.clone().body!.getReader();
  function cancelBothBranches() {
    // Do not wait for a stream source's cancellation handler.
    void reader.cancel().catch(() => undefined);
    cancel(request.body);
  }
  async function checkSize() {
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > AUTHFN_MAX_BODY_BYTES) {
        cancelBothBranches();
        throw new AuthFnPayloadTooLargeError(AUTHFN_MAX_BODY_BYTES);
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      reject(canceledBodyError());
      cancelBothBranches();
    };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      reject(new AuthFnError('AUTHFN_VALIDATION_ERROR', 'Request body did not arrive in time', { status: 408 }));
      cancelBothBranches();
    }, AUTHFN_BODY_READ_TIMEOUT_MS);
  });
  try {
    await Promise.race([checkSize(), interrupted]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function canceledBodyError(): AuthFnError {
  return new AuthFnError('AUTHFN_VALIDATION_ERROR', 'Request body was canceled', { status: 408 });
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => undefined);
}
