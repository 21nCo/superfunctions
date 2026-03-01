import { type ErrorCodeType, ErrorHttpStatus } from 'recfn';

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function err(
  code: ErrorCodeType,
  message: string,
  details?: Record<string, unknown>,
  status?: number,
): Response {
  const httpStatus = status ?? ErrorHttpStatus[code] ?? 500;
  return Response.json(
    {
      ok: false,
      error: { code, message, details: details ?? {} },
    },
    { status: httpStatus },
  );
}
