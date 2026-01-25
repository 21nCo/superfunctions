import type { HttpClient, HttpResponse, RequestConfig } from '../types/action.js';

/**
 * Default HTTP client implementation using fetch
 */
export class FetchHttpClient implements HttpClient {
  private baseTimeout: number;

  constructor(timeout = 30000) {
    this.baseTimeout = timeout;
  }

  async get<T = any>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request('GET', url, undefined, config);
  }

  async post<T = any>(url: string, data?: any, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request('POST', url, data, config);
  }

  async put<T = any>(url: string, data?: any, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request('PUT', url, data, config);
  }

  async patch<T = any>(url: string, data?: any, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request('PATCH', url, data, config);
  }

  async delete<T = any>(url: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request('DELETE', url, undefined, config);
  }

  private async request<T>(
    method: string,
    url: string,
    data?: any,
    config?: RequestConfig
  ): Promise<HttpResponse<T>> {
    const timeout = config?.timeout || this.baseTimeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Build URL with query params
      const finalUrl = config?.params
        ? `${url}?${new URLSearchParams(config.params).toString()}`
        : url;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config?.headers,
      };

      const response = await fetch(finalUrl, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseData: T;
      const contentType = response.headers.get('content-type');
      
      if (contentType?.includes('application/json')) {
        responseData = (await response.json()) as T;
      } else {
        responseData = (await response.text()) as any;
      }

      if (!response.ok) {
        throw new HttpError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          responseData
        );
      }

      return {
        data: responseData,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      
      throw error;
    }
  }
}

/**
 * HTTP error class
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: any
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

