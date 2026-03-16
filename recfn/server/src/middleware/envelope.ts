import { type ErrorCodeType, ErrorHttpStatus } from 'recfn';
import { createErrorRegistry } from '@superfunctions/errors';
import { err as createEnvelopeError, ok as createEnvelopeSuccess, toLegacyDataEnvelope } from '@superfunctions/envelope';

const errorRegistry = createErrorRegistry(
  Object.entries(ErrorHttpStatus).map(([code, httpStatus]) => ({
    code,
    httpStatus: Number(httpStatus),
    retryable: Number(httpStatus) >= 500 || Number(httpStatus) === 429,
  }))
);

export function ok<T>(data: T, status = 200): Response {
  const canonical = createEnvelopeSuccess(data);
  return Response.json(toLegacyDataEnvelope(canonical), { status });
}

export function err(
  code: ErrorCodeType,
  message: string,
  details?: Record<string, unknown>,
  status?: number,
): Response {
  const resolved = errorRegistry.resolveOrDefault(code, {
    httpStatus: status ?? ErrorHttpStatus[code] ?? 500,
    retryable: (status ?? ErrorHttpStatus[code] ?? 500) >= 500 || (status ?? ErrorHttpStatus[code] ?? 500) === 429,
  });
  const canonical = createEnvelopeError({
    code,
    message,
    status: resolved.httpStatus,
    retryable: resolved.retryable,
    details: details ?? {},
  });

  return Response.json(toLegacyDataEnvelope(canonical), { status: canonical.error.status });
}
