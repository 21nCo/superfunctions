/** Maintains an active callback's receipt without extending it after uncertain renewal. */
export class DeliveryLease {
  readonly controller = new AbortController();
  private stopped = false;
  private renewing = true;
  private confirmedDeadline = 0;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  constructor(private duration: number, acquiredAt: number, private renew: () => Promise<boolean>, private onLost: () => void) {
    if (performance.now() >= acquiredAt + duration) { this.lose(); return; }
    this.deadline(acquiredAt + duration);
    this.schedule();
  }
  private deadline(at: number): void {
    this.confirmedDeadline = at;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => this.lose(), Math.max(0, at - performance.now()));
  }
  private schedule(): void {
    if (this.stopped || !this.renewing) return;
    this.renewalTimer = setTimeout(() => void this.tick(), Math.max(1, this.duration / 3));
  }
  private async tick(): Promise<void> {
    const began = performance.now();
    if (began >= this.confirmedDeadline) { this.lose(); return; }
    try {
      const owned = await this.renew();
      if (this.stopped) return;
      const returnedAt = performance.now();
      if (!owned || returnedAt >= this.confirmedDeadline || returnedAt >= began + this.duration) { this.lose(); return; }
      this.deadline(began + this.duration);
    } catch { /* Retry transport failures only within the last confirmed deadline. */ }
    this.schedule();
  }
  private lose(): void {
    if (this.stopped) return;
    this.stop();
    this.controller.abort();
    this.onLost();
  }
  /** Keep expiry observation after the callback returns without settlement. */
  stopRenewal(): void {
    this.renewing = false;
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
  }
  stop(): void {
    this.stopped = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
  }
  abort(): void { this.stop(); this.controller.abort(); }
}
