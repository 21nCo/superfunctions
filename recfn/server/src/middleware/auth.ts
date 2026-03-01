import { ErrorCode, RecFnError } from 'recfn';

export interface AuthResult {
  namespace: string;
  apiKey: string;
}

export type ValidateApiKey = (
  apiKey: string,
) => Promise<AuthResult | null> | AuthResult | null;

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function authenticate(
  request: Request,
  validateApiKey: ValidateApiKey,
): Promise<AuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new RecFnError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Missing or invalid Authorization header. Use Bearer <api-key>.',
    });
  }

  const result = await validateApiKey(token);
  if (!result) {
    throw new RecFnError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Invalid API key.',
    });
  }

  return result;
}
