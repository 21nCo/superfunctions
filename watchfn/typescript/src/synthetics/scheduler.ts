import { WatchFn } from "../core/watch-fn";
import { HttpCheckRunner } from "./http-check";
import { SyntheticCheck } from "./types";

export class SyntheticScheduler {
  private watch: WatchFn;
  private checks: Map<string, SyntheticCheck> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private httpRunner: HttpCheckRunner;

  constructor(watch: WatchFn) {
    this.watch = watch;
    this.httpRunner = new HttpCheckRunner();
  }

  async create(check: SyntheticCheck) {
    const id = check.id || Math.random().toString(36).substring(7);
    const newCheck = { ...check, id };
    this.checks.set(id, newCheck);
    this.schedule(newCheck);
    return newCheck;
  }

  private schedule(check: SyntheticCheck) {
    if (this.timers.has(check.id!)) {
      clearInterval(this.timers.get(check.id!)!);
    }

    const interval = setInterval(() => this.run(check), check.interval);
    this.timers.set(check.id!, interval);
    
    // Run immediately once
    this.run(check);
  }

  private async run(check: SyntheticCheck) {
    if (check.type === "http") {
      const result = await this.httpRunner.run(check);
      this.watch.track("synthetics.check", result as any);
      
      if (!result.success) {
          // Could trigger specific alert logic here
      }
    }
    // Browser runner not implemented yet
  }

  stop() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers.clear();
  }
}
