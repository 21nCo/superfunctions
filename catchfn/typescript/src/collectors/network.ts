/**
 * Network activity collector - tracks HTTP requests
 */

import type { NetworkRequest, ContextCollector } from "../core/types.js";

export class NetworkCollector implements ContextCollector<NetworkRequest[]> {
  private requests: NetworkRequest[] = [];
  private maxSize: number;
  private originalFetch?: typeof fetch;
  private originalXHROpen?: typeof XMLHttpRequest.prototype.open;
  private originalXHRSend?: typeof XMLHttpRequest.prototype.send;
  private isActive = false;
  private sensitiveHeaders = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
  ]);

  constructor(maxSize: number = 20) {
    this.maxSize = maxSize;
  }

  /**
   * Start intercepting network requests
   */
  start(): void {
    if (this.isActive) return;

    this.interceptFetch();
    this.interceptXHR();

    this.isActive = true;
  }

  /**
   * Stop intercepting network requests
   */
  stop(): void {
    if (!this.isActive) return;

    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
    }

    if (this.originalXHROpen) {
      XMLHttpRequest.prototype.open = this.originalXHROpen;
    }

    if (this.originalXHRSend) {
      XMLHttpRequest.prototype.send = this.originalXHRSend;
    }

    this.isActive = false;
  }

  /**
   * Intercept fetch API
   */
  private interceptFetch(): void {
    if (typeof fetch === "undefined") return;

    this.originalFetch = fetch;

    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      const startTime = Date.now();
      const url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] instanceof URL
            ? args[0].href
            : args[0].url;
      const method = args[1]?.method || "GET";

      try {
        const response = await this.originalFetch!(...args);
        const duration = Date.now() - startTime;

        this.addRequest({
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          duration,
          timestamp: startTime,
          requestHeaders: this.extractHeaders(args[1]?.headers),
          responseHeaders: this.extractHeaders(response.headers),
        });

        return response;
      } catch (error) {
        const duration = Date.now() - startTime;

        this.addRequest({
          url,
          method,
          duration,
          timestamp: startTime,
          requestHeaders: this.extractHeaders(args[1]?.headers),
        });

        throw error;
      }
    };
  }

  /**
   * Intercept XMLHttpRequest
   */
  private interceptXHR(): void {
    if (typeof XMLHttpRequest === "undefined") return;

    this.originalXHROpen = XMLHttpRequest.prototype.open;
    this.originalXHRSend = XMLHttpRequest.prototype.send;

    const collector = this;

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ) {
      (this as any).__catchfn_method = method;
      (this as any).__catchfn_url = String(url);
      (this as any).__catchfn_startTime = Date.now();

      return collector.originalXHROpen!.call(
        this,
        method,
        url,
        async ?? true,
        username,
        password
      );
    };

    XMLHttpRequest.prototype.send = function (...args: any[]) {
      this.addEventListener("loadend", function () {
        const duration = Date.now() - (this as any).__catchfn_startTime;

        collector.addRequest({
          url: (this as any).__catchfn_url,
          method: (this as any).__catchfn_method,
          status: this.status,
          statusText: this.statusText,
          duration,
          timestamp: (this as any).__catchfn_startTime,
        });
      });

      return collector.originalXHRSend!.call(this, ...args);
    };
  }

  /**
   * Extract and sanitize headers
   */
  private extractHeaders(
    headers?: HeadersInit | Headers
  ): Record<string, string> | undefined {
    if (!headers) return undefined;

    const result: Record<string, string> = {};

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        if (!this.sensitiveHeaders.has(key.toLowerCase())) {
          result[key] = value;
        } else {
          result[key] = "[REDACTED]";
        }
      });
    } else if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        if (!this.sensitiveHeaders.has(key.toLowerCase())) {
          result[key] = value;
        } else {
          result[key] = "[REDACTED]";
        }
      });
    } else {
      Object.entries(headers).forEach(([key, value]) => {
        if (!this.sensitiveHeaders.has(key.toLowerCase())) {
          result[key] = String(value);
        } else {
          result[key] = "[REDACTED]";
        }
      });
    }

    return result;
  }

  /**
   * Add a network request
   */
  private addRequest(request: NetworkRequest): void {
    this.requests.push(request);

    // Maintain size limit
    if (this.requests.length > this.maxSize) {
      this.requests.shift();
    }
  }

  /**
   * Collect all network requests
   */
  collect(): NetworkRequest[] {
    return [...this.requests];
  }

  /**
   * Clear all network requests
   */
  clear(): void {
    this.requests = [];
  }

  /**
   * Get the current number of requests
   */
  size(): number {
    return this.requests.length;
  }
}
