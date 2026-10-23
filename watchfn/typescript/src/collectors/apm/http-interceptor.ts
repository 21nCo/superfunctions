import { WatchFn } from "../../core/watch-fn";

export class HttpInterceptor {
  private watch: WatchFn;
  private originalFetch: typeof fetch | null = null;

  constructor(watch: WatchFn) {
    this.watch = watch;
  }

  install() {
    // Intercept global fetch if available
    if (typeof fetch !== "undefined") {
      this.originalFetch = fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const start = Date.now();
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || "GET";

        try {
          const response = await this.originalFetch!(input, init);
          const duration = Date.now() - start;
          
          this.watch.track("http.client.request", {
            url,
            method,
            statusCode: response.status,
            duration,
          });

          return response;
        } catch (error) {
          const duration = Date.now() - start;
          this.watch.track("http.client.request", {
            url,
            method,
            error: error instanceof Error ? error.message : String(error),
            duration,
          });
          throw error;
        }
      };
    }

    // Could also intercept XHR or Node.js http/https modules here
  }

  uninstall() {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }
}
