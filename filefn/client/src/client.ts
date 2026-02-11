import type {
  FileFnClientConfig,
  InitUploadResponse,
  UploadStatusResponse,
  SignPartResponse,
  CompletePartResponse,
  CompleteUploadResponse,
  AbortUploadResponse,
} from "./types.js";
import {
  resolveRetryOptions,
  withRetry,
  type ResolvedRetryOptions,
} from "./retry.js";

export interface FileFnErrorDetails {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class FileFnHttpError extends Error {
  public readonly code?: string;
  public readonly requestId?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "FileFnHttpError";

    // Extract structured error from canonical envelope
    if (body && typeof body === "object" && "error" in body) {
      const envelope = body as {
        ok: false;
        error: FileFnErrorDetails;
        requestId?: string;
      };
      this.code = envelope.error.code;
      this.details = envelope.error.details;
      if (envelope.requestId) {
        this.requestId = envelope.requestId;
      }
    }
  }
}

export interface HttpClient {
  initUpload(
    params: {
      policy: string;
      fileName: string;
      size: number;
      mimeType: string;
      metadata?: Record<string, unknown>;
      fileId?: string;
      idempotencyKey?: string;
    },
    signal?: AbortSignal,
  ): Promise<InitUploadResponse>;

  getFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;

  downloadUrl(
    fileId: string,
    options?: { versionId?: string },
    signal?: AbortSignal,
  ): Promise<{ url: string }>;

  deleteFile(fileId: string, signal?: AbortSignal): Promise<void>;

  getUploadStatus(
    uploadSessionId: string,
    signal?: AbortSignal,
  ): Promise<UploadStatusResponse>;

  signPart(
    uploadSessionId: string,
    partNumber: number,
    contentLength: number,
    signal?: AbortSignal,
  ): Promise<SignPartResponse>;

  completePart(
    uploadSessionId: string,
    partNumber: number,
    etag: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<CompletePartResponse>;

  completeUpload(
    uploadSessionId: string,
    signal?: AbortSignal,
  ): Promise<CompleteUploadResponse>;

  abortUpload(
    uploadSessionId: string,
    signal?: AbortSignal,
  ): Promise<AbortUploadResponse>;

  uploadPartToSignedUrl(
    url: string,
    headers: Record<string, string>,
    body: Blob,
    signal?: AbortSignal,
  ): Promise<{ etag: string; recorded?: boolean }>;
}

export function createHttpClient(config: FileFnClientConfig): HttpClient {
  const retryOptions = resolveRetryOptions(config.retryOptions);
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  async function getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
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
    options: ResolvedRetryOptions = retryOptions,
  ): Promise<T> {
    return withRetry(
      async () => {
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
            errorBody,
          );
        }

        const json = await response.json();

        // Unwrap canonical envelope { ok: true, data: T }
        if (
          json &&
          typeof json === "object" &&
          "ok" in json &&
          json.ok === true &&
          "data" in json
        ) {
          return json.data as T;
        }

        // If not a canonical envelope, return as-is for backwards compatibility
        return json as T;
      },
      options,
      signal,
    );
  }

  return {
    async initUpload(params, signal) {
      return request<InitUploadResponse>(
        "POST",
        "/upload/init",
        params,
        signal,
      );
    },

    async getFile(fileId, signal) {
      return request<Record<string, unknown>>(
        "GET",
        `/${fileId}`,
        undefined,
        signal,
      );
    },

    async downloadUrl(fileId, options, signal) {
      const path = options?.versionId
        ? `/${fileId}/versions/${options.versionId}/download`
        : `/${fileId}/download`;
      return request<{ url: string }>("GET", path, undefined, signal);
    },

    async deleteFile(fileId, signal) {
      await request<void>("DELETE", `/${fileId}`, undefined, signal);
    },

    async getUploadStatus(uploadSessionId, signal) {
      return request<UploadStatusResponse>(
        "GET",
        `/upload/${uploadSessionId}/status`,
        undefined,
        signal,
      );
    },

    async signPart(uploadSessionId, partNumber, contentLength, signal) {
      return request<SignPartResponse>(
        "POST",
        `/upload/${uploadSessionId}/parts/${partNumber}/sign`,
        { contentLength },
        signal,
      );
    },

    async completePart(uploadSessionId, partNumber, etag, size, signal) {
      return request<CompletePartResponse>(
        "POST",
        `/upload/${uploadSessionId}/parts/${partNumber}/complete`,
        { etag, size },
        signal,
      );
    },

    async completeUpload(uploadSessionId, signal) {
      return request<CompleteUploadResponse>(
        "POST",
        `/upload/${uploadSessionId}/complete`,
        undefined,
        signal,
      );
    },

    async abortUpload(uploadSessionId, signal) {
      return request<AbortUploadResponse>(
        "POST",
        `/upload/${uploadSessionId}/abort`,
        undefined,
        signal,
      );
    },

    async uploadPartToSignedUrl(url, headers, body, signal) {
      return withRetry(
        async () => {
          // If URL is relative (proxy upload), prepend baseUrl
          const finalUrl = url.startsWith("/") ? `${baseUrl}${url}` : url;

          const response = await fetch(finalUrl, {
            method: "PUT",
            headers,
            body,
            signal,
          });

          if (!response.ok) {
            throw new FileFnHttpError(
              `Upload failed: HTTP ${response.status}`,
              response.status,
            );
          }

          // Check if response is JSON (proxy upload)
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const json = await response.json();
            // Canonical envelope check
            if (
              json &&
              typeof json === "object" &&
              "ok" in json &&
              json.ok === true &&
              "data" in json
            ) {
              return {
                etag: json.data.etag,
                recorded: json.data.recorded,
              };
            }
            // Fallback or raw json
            return { etag: json.etag || "", recorded: json.recorded };
          }

          return { etag: response.headers.get("ETag") || "" };
        },
        retryOptions,
        signal,
      );
    },
  };
}
