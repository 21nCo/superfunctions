import type { AuthFnClientOptions, AuthFnErrorEnvelope } from './types.js';

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  csrf?: boolean;
}

export function createAuthFnHttpClient(options: AuthFnClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? '/auth').replace(/\/$/, '');
  const credentials = options.credentials ?? 'include';
  const cookieAccessor = options.cookieAccessor ?? defaultCookieAccessor;

  return {
    requestJson: async <T>(request: RequestOptions): Promise<T | AuthFnErrorEnvelope> => {
      const headers = new Headers();

      if (request.body !== undefined) {
        headers.set('content-type', 'application/json');
      }

      if (request.csrf) {
        const csrfToken = readCookieValue(cookieAccessor(), `${readCookiePrefix(cookieAccessor())}.csrf`);
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
        return { redirectTo: response.headers.get('location')! } as T;
      }

      return response.json() as Promise<T | AuthFnErrorEnvelope>;
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
    const trimmed = part.trim();
    if (trimmed.startsWith('__Secure-') && trimmed.endsWith('.session')) {
      return trimmed.slice('__Secure-'.length, -'.session'.length);
    }
    if (trimmed.endsWith('.session')) {
      return trimmed.slice(0, -'.session'.length);
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
