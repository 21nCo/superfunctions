import { randomBytes } from 'node:crypto';
import type { AuthFnError, AuthFnErrorEnvelope, AuthFnSuccessEnvelope } from '../types.js';
import { toAuthFnError } from '../core/errors.js';

const requestIds = new WeakMap<Request, string>();

export function resolveRequestId(request: Request): string {
  const cached = requestIds.get(request);
  if (cached) {
    return cached;
  }

  const incoming = request.headers.get('x-request-id')?.trim();
  if (incoming) {
    requestIds.set(request, incoming);
    return incoming;
  }

  const generated = createRequestId();
  requestIds.set(request, generated);
  return generated;
}

export function createRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

export function successEnvelope<TData>(
  requestId: string,
  data: TData
): AuthFnSuccessEnvelope<TData> {
  return {
    ok: true,
    data,
    requestId
  };
}

export function errorEnvelope(
  requestId: string,
  error: AuthFnError | unknown
): AuthFnErrorEnvelope {
  const authError = isAuthFnError(error) ? error : toAuthFnError(error);

  return {
    ok: false,
    error: {
      code: authError.code,
      message: authError.message,
      retryable: authError.retryable,
      details: authError.details
    },
    requestId
  };
}

export function jsonSuccess<TData>(
  request: Request,
  data: TData,
  init?: ResponseInit & { setCookies?: string[] }
): Response {
  const requestId = resolveRequestId(request);
  return jsonWithHeaders(successEnvelope(requestId, data), requestId, init);
}

export function jsonError(
  request: Request,
  error: unknown
): Response {
  const requestId = resolveRequestId(request);
  const authError = toAuthFnError(error);
  return jsonWithHeaders(errorEnvelope(requestId, authError), requestId, {
    status: authError.status
  });
}

function jsonWithHeaders(
  body: unknown,
  requestId: string,
  init?: ResponseInit & { setCookies?: string[] }
): Response {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-request-id', requestId);

  for (const cookie of init?.setCookies ?? []) {
    headers.append('set-cookie', cookie);
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers
  });
}

function isAuthFnError(value: unknown): value is AuthFnError {
  return typeof value === 'object' && value !== null && 'code' in value && 'status' in value && 'retryable' in value;
}
