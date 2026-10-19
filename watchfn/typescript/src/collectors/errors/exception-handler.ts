import type { WatchFn } from "../../core/watch-fn";
import { Breadcrumbs } from "./breadcrumbs";

export interface ExceptionCaptureOptions {
  enabled?: boolean;
  captureUnhandled?: boolean;
  captureRejections?: boolean;
  ignoreErrors?: Array<string | RegExp>;
}

export class ExceptionHandler {
  private readonly breadcrumbs = new Breadcrumbs();
  private installed = false;
  private disposers: Array<() => void> = [];

  constructor(private readonly watch: Pick<WatchFn, "captureException">) {}

  install(options: ExceptionCaptureOptions = {}) {
    if (this.installed || options.enabled === false) return;
    this.installed = true;
    const captureUnhandled = options.captureUnhandled !== false;
    const captureRejections = options.captureRejections !== false;
    const capture = (error: unknown, context: Record<string, unknown>) => {
      try {
        const message = error instanceof Error ? error.message : String(error);
        if (options.ignoreErrors?.some(pattern => typeof pattern === "string"
          ? message.includes(pattern) : new RegExp(pattern.source, pattern.flags).test(message))) return;
        this.watch.captureException(error, { ...context, breadcrumbs: this.breadcrumbs.all() });
      } catch { /* Monitoring must not replace the application's error behavior. */ }
    };
    try {
      if (typeof window !== "undefined") {
        const target = window;
        if (captureUnhandled) {
          const onError = (event: ErrorEvent) => capture(event.error ?? new Error(event.message), {
            message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno,
          });
          target.addEventListener("error", onError);
          this.disposers.push(() => target.removeEventListener("error", onError));
        }
        if (captureRejections) {
          const onRejection = (event: PromiseRejectionEvent) => capture(event.reason, { type: "unhandledrejection" });
          target.addEventListener("unhandledrejection", onRejection);
          this.disposers.push(() => target.removeEventListener("unhandledrejection", onRejection));
        }
      } else if (typeof process !== "undefined" && (captureUnhandled || captureRejections)) {
        const target = process;
        // Unlike uncaughtException/unhandledRejection listeners, this observes a
        // fatal error without disabling Node's default exit behavior. Rejections
        // reach this monitor in Node's default throw/strict rejection modes.
        const onException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
          const rejection = origin === "unhandledRejection";
          if (rejection ? captureRejections : captureUnhandled) {
            capture(error, { type: rejection ? "unhandledRejection" : "uncaughtException", origin });
          }
        };
        target.on("uncaughtExceptionMonitor", onException);
        this.disposers.push(() => target.removeListener("uncaughtExceptionMonitor", onException));
      }
    } catch (error) {
      this.uninstall();
      throw error;
    }
  }

  uninstall() {
    this.installed = false;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  addBreadcrumb(crumb: any) { this.breadcrumbs.add(crumb); }
  getBreadcrumbs() { return this.breadcrumbs.all(); }
}
