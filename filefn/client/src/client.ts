import type {
  FileFnClientConfig,
  InitUploadResponse,
  UploadStatusResponse,
  SignPartResponse,
  CompletePartResponse,
  CompleteUploadResponse,
  AbortUploadResponse,
} from './types.js';
import { resolveRetryOptions, withRetry, type ResolvedRetryOptions } from './retry.js';

export class FileFnHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'FileFnHttpError';
  }
}

export interface HttpClient {
  initUpload(params: {
    policy: string;
    fileName: string;
    fileSize: number;
    contentType: string;
    metadata?: Record<string, unknown>;
    fileId?: string;
    idempotencyKey?: string;
  }, signal?: AbortSignal): Promise<InitUploadResponse>;

  getUploadStatus(uploadSessionId: string, signal?: AbortSignal): Promise<UploadStatusResponse>;

  signPart(uploadSessionId: string, partNumber: number, signal?: AbortSignal): Promise<SignPartResponse>;

  completePart(uploadSessionId: string, partNumber: number, etag: string, signal?: AbortSignal): Promise<CompletePartResponse>;

  completeUpload(uploadSessionId: string, signal?: AbortSignal): Promise<CompleteUploadResponse>;

  abortUpload(uploadSessionId: string, signal?: AbortSignal): Promise<AbortUploadResponse>;

  uploadPartToSignedUrl(url: string, headers: Record<string, string>, body: Blob, signal?: AbortSignal): Promise<string>;
}

export function createHttpClient(config: FileFnClientConfig): HttpClient {
  const retryOptions = resolveRetryOptions(config.retryOptions);
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  async function getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.getAuthHeaders) {
      const authHeaders = await config.getAuthHeaders();
      Object.assign(headers, authHeaders);
    }

    return headers;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    options: ResolvedRetryOptions = retryOptions
  ): Promise<T> {
    return withRetry(async () => {
      const headers = await getHeaders();
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });

      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }
        throw new FileFnHttpError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          errorBody
        );
      }

      return response.json() as Promise<T>;
    }, options, signal);
  }

  return {
    async initUpload(params, signal) {
      return request<InitUploadResponse>('POST', '/upload/init', params, signal);
    },

    async getUploadStatus(uploadSessionId, signal) {
      return request<UploadStatusResponse>('GET', `/upload/${uploadSessionId}/status`, undefined, signal);
    },

    async signPart(uploadSessionId, partNumber, signal) {
      return request<SignPartResponse>('POST', `/upload/${uploadSessionId}/parts/${partNumber}/sign`, undefined, signal);
    },

    async completePart(uploadSessionId, partNumber, etag, signal) {
      return request<CompletePartResponse>('POST', `/upload/${uploadSessionId}/parts/${partNumber}/complete`, { etag }, signal);
    },

    async completeUpload(uploadSessionId, signal) {
      return request<CompleteUploadResponse>('POST', `/upload/${uploadSessionId}/complete`, undefined, signal);
    },

    async abortUpload(uploadSessionId, signal) {
      return request<AbortUploadResponse>('POST', `/upload/${uploadSessionId}/abort`, undefined, signal);
    },

    async uploadPartToSignedUrl(url, headers, body, signal) {
      return withRetry(async () => {
        const response = await fetch(url, {
          method: 'PUT',
          headers,
          body,
          signal,
        });

        if (!response.ok) {
          throw new FileFnHttpError(
            `Upload failed: HTTP ${response.status}`,
            response.status
          );
        }

        return response.headers.get('ETag') || '';
      }, retryOptions, signal);
    },
  };
}
