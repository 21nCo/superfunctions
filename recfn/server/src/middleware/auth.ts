import {
  createBearerAuthMiddleware as createSharedBearerAuthMiddleware,
  extractBearerToken as extractSharedBearerToken,
} from '@superfunctions/auth';
import { ErrorCode, RecFnError } from 'recfn';

export interface AuthResult {
  namespace: string;
  apiKey: string;
}

export type ValidateApiKey = (
  apiKey: string,
) => Promise<AuthResult | null> | AuthResult | null;

export function extractBearerToken(request: Request): string | null {
  return extractSharedBearerToken(request);
}

export function createBearerAuthMiddleware(validateApiKey: ValidateApiKey) {
  return createSharedBearerAuthMiddleware<AuthResult>({
    validateToken: async (token) => validateApiKey(token),
  });
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
