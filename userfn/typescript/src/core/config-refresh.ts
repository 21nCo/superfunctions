import { ConfigRefreshError } from './config-http';
import type { ConfigRefreshStatus } from '../types';

/** One serial background loop; callers explicitly start and await stop. */
export class ConfigRefreshLoop {
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopping?: Promise<void>;
  private state: ConfigRefreshStatus = { running: false, consecutiveFailures: 0 };
  constructor(private refresh: () => Promise<boolean>, private cancel: () => Promise<void>, private interval: number) {
    if (!Number.isInteger(interval) || interval < 100 || interval > 86400000) throw new TypeError('Configuration refreshInterval must be 100–86400000 milliseconds');
  }
  status(): ConfigRefreshStatus { return { ...this.state }; }
  start(): void {
    if (this.stopping) throw new ConfigRefreshError('Await configuration refresh stop before restarting');
    if (this.state.running) return;
    this.state.running = true; this.state.consecutiveFailures = 0;
    this.tick(++this.epoch);
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state.running = false; this.state.nextRefreshAt = undefined; this.epoch++;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const active = this.active;
    const operation = (async () => { await this.cancel(); await active; })();
    this.stopping = operation;
    void operation.finally(() => { if (this.stopping === operation) this.stopping = undefined; }).catch(() => {});
    return operation;
  }
  private tick(epoch: number): void {
    const operation = (async () => {
      try {
        await this.refresh();
        if (epoch !== this.epoch) return;
        this.state.lastSuccessAt = Date.now(); this.state.lastError = undefined; this.state.consecutiveFailures = 0;
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.state.lastError = error instanceof ConfigRefreshError ? error.message : 'Configuration refresh failed';
        this.state.consecutiveFailures++;
      }
      if (!this.state.running || epoch !== this.epoch) return;
      const delay = Math.min(this.interval * 2 ** Math.min(this.state.consecutiveFailures, 10), Math.max(this.interval, 300000));
      this.state.nextRefreshAt = Date.now() + delay;
      this.timer = setTimeout(() => { this.state.nextRefreshAt = undefined; this.tick(epoch); }, delay);
      // An optional background refresher must not keep a Node process alive by itself.
      (this.timer as unknown as { unref?: () => void }).unref?.();
    })();
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; }).catch(() => {});
  }
}
