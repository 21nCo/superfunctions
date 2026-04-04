import type { AuthFnClientOptions, AuthFnErrorEnvelope } from './types.js';

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  csrf?: boolean;
}

export function createAuthFnHttpClient(options: AuthFnClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? '/auth').replace(/\/$/, '');
  const credentials = options.credentials ?? 'include';
  const cookieAccessor = options.cookieAccessor ?? defaultCookieAccessor;
  const cookiePrefix = options.cookiePrefix?.trim();

  return {
    requestJson: async <T>(request: RequestOptions): Promise<T | AuthFnErrorEnvelope> => {
      const headers = new Headers();

      if (request.body !== undefined) {
        headers.set('content-type', 'application/json');
      }

      if (request.csrf) {
        const cookieHeader = cookieAccessor();
        const csrfToken = readCookieValue(
          cookieHeader,
          `${cookiePrefix || readCookiePrefix(cookieHeader)}.csrf`
        );
        if (csrfToken) {
          headers.set('x-authfn-csrf', csrfToken);
        }
      }

      const response = await fetchImpl(`${baseUrl}${request.path}`, {
        method: request.method,
        headers,
        credentials,
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        return {
          ok: true,
          data: {
            redirectTo: response.headers.get('location')!
          },
          requestId: response.headers.get('x-request-id') ?? 'authfn-redirect'
        } as T;
      }

      const raw = await response.text();
      if (!raw) {
        return {
          ok: true,
          data: {} as Record<string, never>,
          requestId: response.headers.get('x-request-id') ?? 'authfn-empty'
        } as T;
      }

      try {
        return JSON.parse(raw) as T | AuthFnErrorEnvelope;
      } catch {
        return {
          ok: false,
          error: {
            code: 'AUTHFN_INTERNAL_ERROR',
            message: response.ok
              ? 'AuthFn returned a non-JSON response'
              : `AuthFn returned a non-JSON error response (${response.status})`,
            retryable: response.status >= 500,
            details: {
              status: response.status
            }
          },
          requestId: response.headers.get('x-request-id') ?? 'authfn-non-json'
        };
      }
    }
  };
}

function defaultCookieAccessor(): string | undefined {
  const documentLike = globalThis.document as { cookie?: string } | undefined;
  return documentLike?.cookie;
}

function readCookiePrefix(cookieHeader: string | undefined): string {
  if (!cookieHeader) {
    return 'authfn';
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName] = part.trim().split('=');
    if (rawName.startsWith('__Secure-') && rawName.endsWith('.session')) {
      return rawName.slice('__Secure-'.length, -'.session'.length);
    }
    if (rawName.endsWith('.session')) {
      return rawName.slice(0, -'.session'.length);
    }
  }

  return 'authfn';
}

function readCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...valueParts] = part.trim().split('=');
    if (rawName === name) {
      return decodeURIComponent(valueParts.join('='));
    }
  }

  return undefined;
}
