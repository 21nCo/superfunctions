"""Page load performance tracking for RUM."""

export interface PageLoadMetrics {
  url: string;
  timestamp: number;
  
  // Navigation Timing metrics
  dns: number;
  tcp: number;
  request: number;
  response: number;
  domProcessing: number;
  domContentLoaded: number;
  onLoad: number;
  
  // Total times
  ttfb: number; // Time to First Byte
  domInteractive: number;
  domComplete: number;
  loadComplete: number;
  
  // Additional context
  referrer?: string;
  userAgent?: string;
  deviceType?: "desktop" | "mobile" | "tablet";
}

export class PageLoadTracker {
  /**
   * Capture page load metrics (browser only)
   */
  captureMetrics(): PageLoadMetrics | null {
    if (typeof window === "undefined" || !window.performance) {
      return null;
    }

    const timing = window.performance.timing;
    const navigation = window.performance.navigation;

    const metrics: PageLoadMetrics = {
      url: window.location.href,
      timestamp: Date.now(),
      
      // Calculate timing segments
      dns: timing.domainLookupEnd - timing.domainLookupStart,
      tcp: timing.connectEnd - timing.connectStart,
      request: timing.responseStart - timing.requestStart,
      response: timing.responseEnd - timing.responseStart,
      domProcessing: timing.domComplete - timing.domLoading,
      domContentLoaded: timing.domContentLoadedEventEnd - timing.domContentLoadedEventStart,
      onLoad: timing.loadEventEnd - timing.loadEventStart,
      
      // Total times
      ttfb: timing.responseStart - timing.navigationStart,
      domInteractive: timing.domInteractive - timing.navigationStart,
      domComplete: timing.domComplete - timing.navigationStart,
      loadComplete: timing.loadEventEnd - timing.navigationStart,
      
      // Context
      referrer: document.referrer || undefined,
      userAgent: navigator.userAgent,
      deviceType: this.getDeviceType(),
    };

    return metrics;
  }

  /**
   * Wait for page load and capture metrics
   */
  async captureOnLoad(): Promise<PageLoadMetrics | null> {
    return new Promise((resolve) => {
      if (document.readyState === "complete") {
        resolve(this.captureMetrics());
      } else {
        window.addEventListener("load", () => {
          // Wait a bit for all events to finish
          setTimeout(() => {
            resolve(this.captureMetrics());
          }, 100);
        });
      }
    });
  }

  /**
   * Get performance entry for current navigation
   */
  getPerformanceEntry(): PerformanceNavigationTiming | null {
    if (typeof window === "undefined" || !window.performance) {
      return null;
    }

    const entries = window.performance.getEntriesByType("navigation");
    return (entries[0] as PerformanceNavigationTiming) || null;
  }

  private getDeviceType(): "desktop" | "mobile" | "tablet" {
    const ua = navigator.userAgent;
    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
      return "tablet";
    }
    if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) {
      return "mobile";
    }
    return "desktop";
  }
}
