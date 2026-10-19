/** Maintains an active callback's receipt without extending it after uncertain renewal. */
export class DeliveryLease {
  readonly controller = new AbortController();
  private stopped = false;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  constructor(private duration: number, acquiredAt: number, private renew: () => Promise<boolean>, private onLost: () => void) {
    this.deadline(acquiredAt + duration);
    this.schedule();
  }
  private deadline(at: number): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => this.lose(), Math.max(0, at - performance.now()));
  }
  private schedule(): void {
    if (this.stopped) return;
    this.renewalTimer = setTimeout(() => void this.tick(), Math.max(1, this.duration / 3));
  }
  private async tick(): Promise<void> {
    const began = performance.now();
    try {
      const owned = await this.renew();
      if (this.stopped) return;
      if (!owned || performance.now() >= began + this.duration) { this.lose(); return; }
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
  stop(): void {
    this.stopped = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
  }
  abort(): void { this.stop(); this.controller.abort(); }
}
