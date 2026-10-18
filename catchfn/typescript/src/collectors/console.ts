import type { ConsoleLogEntry, ContextCollector } from "../core/types.js";
import { safeSerialize } from "../utils/serialization.js";

type ConsoleMethod = ConsoleLogEntry["level"];
type Listener = (level: ConsoleMethod, args: any[]) => void;
let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    listeners = new Set();
    const current = listeners;
    const originals = new Map<ConsoleMethod, typeof console.log>();
    const wrappers = new Map<ConsoleMethod, typeof console.log>();
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const original = console[level];
      const wrapper = (...args: any[]) => {
        original.apply(console, args);
        for (const receive of current) receive(level, args);
      };
      originals.set(level, original);
      wrappers.set(level, wrapper);
      console[level] = wrapper;
    }
    restore = () => {
      for (const [level, original] of originals) {
        if (console[level] === wrappers.get(level)) console[level] = original;
      }
    };
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current === listeners && current.size === 0) { restore?.(); restore = undefined; }
  };
}

export class ConsoleCollector implements ContextCollector<ConsoleLogEntry[]> {
  private logs: ConsoleLogEntry[] = [];
  private unsubscribe?: () => void;
  constructor(private maxSize = 100) {
    if (!Number.isInteger(maxSize) || maxSize < 0) throw new RangeError("maxSize must be nonnegative");
  }
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((level, args) => {
      if (this.maxSize === 0) return;
      this.logs.push({ level, args: safeSerialize(args), timestamp: Date.now() });
      if (this.logs.length > this.maxSize) this.logs.shift();
    });
  }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  collect(): ConsoleLogEntry[] { return safeSerialize(this.logs); }
  clear(): void { this.logs = []; }
  size(): number { return this.logs.length; }
}
