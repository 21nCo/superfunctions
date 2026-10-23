import { WatchFn } from "../../core/watch-fn";
import { Breadcrumbs } from "./breadcrumbs";

export class ExceptionHandler {
  private watch: WatchFn;
  private breadcrumbs: Breadcrumbs;

  constructor(watch: WatchFn) {
    this.watch = watch;
    this.breadcrumbs = new Breadcrumbs();
  }

  install() {
    if (typeof window !== "undefined") {
      window.addEventListener("error", (event) => {
        this.watch.captureException(event.error, {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          breadcrumbs: this.breadcrumbs.all(),
        });
      });

      window.addEventListener("unhandledrejection", (event) => {
        this.watch.captureException(event.reason, {
          type: "unhandledrejection",
          breadcrumbs: this.breadcrumbs.all(),
        });
      });
    } else if (typeof process !== "undefined") {
      process.on("uncaughtException", (error) => {
        this.watch.captureException(error, {
          type: "uncaughtException",
          breadcrumbs: this.breadcrumbs.all(),
        });
      });

      process.on("unhandledRejection", (reason) => {
        this.watch.captureException(reason, {
          type: "unhandledRejection",
          breadcrumbs: this.breadcrumbs.all(),
        });
      });
    }
  }

  addBreadcrumb(crumb: any) {
    this.breadcrumbs.add(crumb);
  }

  getBreadcrumbs() {
    return this.breadcrumbs.all();
  }
}
