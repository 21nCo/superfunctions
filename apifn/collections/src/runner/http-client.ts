import type { HttpClient, HttpClientRequest, HttpClientResponse } from "../types.js";

function toHeadersRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function createFetchHttpClient(fetchImpl: typeof fetch = fetch): HttpClient {
  return {
    async send(request: HttpClientRequest): Promise<HttpClientResponse> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = request.timeout ?? 30_000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });

        const body = await response.text();
        const duration = Date.now() - startedAt;

        return {
          status: response.status,
          headers: toHeadersRecord(response.headers),
          body,
          size: Buffer.byteLength(body, "utf8"),
          duration,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
