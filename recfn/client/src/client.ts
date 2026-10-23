import type { Envelope, EnvelopeError } from '@recfn/core';

export interface RecFnClientConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: EnvelopeError['error'] };

export class RecFnHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: RecFnClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options?.headers,
    };

    let body: string | undefined;
    if (options?.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchFn(url, {
      method,
      headers,
      body,
    });

    const contentType = res.headers.get('Content-Type') ?? '';
    const isJson = contentType.includes('application/json');

    if (!res.ok) {
      if (isJson) {
        const json = (await res.json()) as EnvelopeError;
        if (json.ok === false && json.error) {
          return { ok: false, error: json.error };
        }
      }
      return {
        ok: false,
        error: {
          code: 'HTTP_ERROR',
          message: `HTTP ${res.status}: ${res.statusText}`,
          details: {},
        },
      };
    }

    if (isJson) {
      const json = (await res.json()) as Envelope<T>;
      if (json.ok === true) {
        return { ok: true, data: json.data };
      }
      if (json.ok === false && 'error' in json) {
        const err = json as unknown as EnvelopeError;
        return { ok: false, error: err.error };
      }
    }

    return {
      ok: false,
      error: {
        code: 'PARSE_ERROR',
        message: 'Unexpected response format',
        details: {},
      },
    };
  }

  /** Raw request for non-JSON responses (e.g. transcript srt/vtt/text). */
  async requestRaw(
    method: string,
    path: string,
    options?: { headers?: Record<string, string> },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options?.headers,
    };
    return this.fetchFn(url, { method, headers });
  }

  /** FormData request for multipart uploads. */
  async requestForm(
    method: string,
    path: string,
    formData: FormData,
    options?: { headers?: Record<string, string> },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options?.headers,
    };
    return this.fetchFn(url, { method, headers, body: formData });
  }

  get baseUrlForWs(): string {
    return this.baseUrl;
  }

  get apiKeyForAuth(): string {
    return this.apiKey;
  }

  getWsUrl(path: string, token?: string): string {
    const base = this.baseUrlForWs.replace(/^http/, 'ws');
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const t = token ?? this.apiKeyForAuth;
    if (t) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}token=${encodeURIComponent(t)}`;
    }
    return url;
  }
}
