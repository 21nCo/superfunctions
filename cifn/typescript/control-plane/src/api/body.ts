import { createRouteContext, PayloadTooLargeError } from '@superfunctions/http';

/** Transport envelope cap; the separate 500 KB pipeline-document limit still applies. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export { PayloadTooLargeError };

export function readBodyText(request: Request): Promise<string> {
  return createRouteContext(request, {}, { maxBodyBytes: MAX_REQUEST_BODY_BYTES }).text();
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  const body: unknown = await createRouteContext(request, {}, { maxBodyBytes: MAX_REQUEST_BODY_BYTES }).json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SyntaxError('Request body must be a JSON object');
  }
  return body as T;
}
