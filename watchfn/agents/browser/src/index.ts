import { onCLS, onFID, onLCP } from "./vitals";

export interface BrowserConfig {
  endpoint: string;
  projectId: string;
  sampleRate?: number;
  autoTrack?: boolean;
}

export class BrowserClient {
  private config: BrowserConfig;
  private queue: any[] = [];
  private isProcessing = false;

  constructor(config: BrowserConfig) {
    this.config = config;
    if (config.autoTrack !== false) {
      this.initRUM();
    }
  }

  private initRUM() {
    // Web Vitals
    onCLS(metric => this.track("web_vital", metric));
    onFID(metric => this.track("web_vital", metric));
    onLCP(metric => this.track("web_vital", metric));

    // Page Views
    if (typeof window !== "undefined") {
        this.track("page_view", {
            path: window.location.pathname,
            referrer: document.referrer,
            title: document.title,
        });
        
        // Track history changes if possible, but keeping it simple for now
    }
  }

  track(name: string, properties: any = {}) {
    if (typeof window === "undefined") return;

    this.queue.push({
      type: "track",
      name,
      properties,
      timestamp: new Date().toISOString(),
      projectId: this.config.projectId,
      url: window.location.href,
      userAgent: navigator.userAgent,
    });
    this.flush();
  }

  private async flush() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const batch = [...this.queue];
    this.queue = [];

    try {
      await fetch(this.config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        keepalive: true, 
      });
    } catch (e) {
      console.error("WatchFn: Failed to send events", e);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
          this.flush();
      }
    }
  }
}

export function init(config: BrowserConfig) {
  return new BrowserClient(config);
}
