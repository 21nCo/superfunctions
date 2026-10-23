import { WatchFn } from "../../core/watch-fn";

export class WebVitalsCollector {
  private watch: WatchFn;
  private observers: PerformanceObserver[] = [];

  constructor(watch: WatchFn) {
    this.watch = watch;
  }

  install() {
    if (typeof window === "undefined" || !window.PerformanceObserver) return;

    try {
      // LCP (Largest Contentful Paint)
      this.observe("largest-contentful-paint", (entries) => {
        const lastEntry = entries[entries.length - 1];
        this.trackMetric("LCP", lastEntry.startTime);
      });

      // FID (First Input Delay)
      this.observe("first-input", (entries) => {
        const entry = entries[0] as any;
        const delay = entry.processingStart - entry.startTime;
        this.trackMetric("FID", delay);
      });

      // CLS (Cumulative Layout Shift)
      let clsValue = 0;
      this.observe("layout-shift", (entries) => {
        for (const entry of entries as any[]) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
        this.trackMetric("CLS", clsValue);
      });

      // FCP (First Contentful Paint)
      this.observe("paint", (entries) => {
        for (const entry of entries) {
          if (entry.name === "first-contentful-paint") {
            this.trackMetric("FCP", entry.startTime);
          }
        }
      });
    } catch (e) {
      // console.warn("PerformanceObserver not supported for some metrics", e);
    }
  }

  private observe(type: string, callback: (entries: PerformanceEntryList) => void) {
    try {
      const observer = new PerformanceObserver((list) => {
        callback(list.getEntries());
      });
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
    } catch (e) {
      // Type not supported
    }
  }

  private trackMetric(name: string, value: number) {
    this.watch.track("rum.web_vital", {
      metric: name,
      value,
      url: window.location.href,
    });
  }

  uninstall() {
    this.observers.forEach((o) => o.disconnect());
    this.observers = [];
  }
}
