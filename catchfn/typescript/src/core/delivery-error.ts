import type { BugReportEvent } from "./types.js";

/** A prepared report failed delivery. Retry preserves its ID and prepared payload. */
export class CatchFnDeliveryError extends Error {
  readonly reportId: string;
  readonly status?: number;
  private active?: Promise<BugReportEvent>;
  private delivered?: BugReportEvent;
  constructor(cause: unknown, reportId: string, private readonly deliver: () => Promise<BugReportEvent>) {
    super(cause instanceof Error ? cause.message : "Bug report delivery failed", { cause });
    this.name = "CatchFnDeliveryError";
    this.reportId = reportId;
    const original = cause instanceof WatchCaptureFailure ? cause.cause : cause;
    if (original && typeof original === "object" && "status" in original && typeof original.status === "number") this.status = original.status;
  }
  retry(): Promise<BugReportEvent> {
    if (this.delivered) return Promise.resolve(this.delivered);
    if (!this.active) {
      this.active = this.deliver().then(report => { this.delivered = report; return report; })
        .catch(cause => { this.cause = cause; throw this; })
        .finally(() => { this.active = undefined; });
    }
    return this.active;
  }
}

/** Internal transport boundary distinguishes queue rejection from delivery failure. */
export class WatchCaptureFailure extends Error {
  constructor(cause: unknown, readonly retryDelivery: () => Promise<void>) {
    super(cause instanceof Error ? cause.message : "WatchFn delivery failed", { cause });
  }
}
