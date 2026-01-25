/**
 * Console log collector - captures console output
 */

import type { ConsoleLogEntry, ContextCollector } from "../core/types.js";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

export class ConsoleCollector implements ContextCollector<ConsoleLogEntry[]> {
  private logs: ConsoleLogEntry[] = [];
  private maxSize: number;
  private originalMethods: Map<ConsoleMethod, (...args: any[]) => void> =
    new Map();
  private isActive = false;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Start intercepting console methods
   */
  start(): void {
    if (this.isActive) return;

    const methods: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

    methods.forEach((method) => {
      // Store original method
      this.originalMethods.set(method, console[method].bind(console));

      // Replace with interceptor
      console[method] = (...args: any[]) => {
        // Call original
        this.originalMethods.get(method)?.(...args);

        // Capture
        this.capture(method, args);
      };
    });

    this.isActive = true;
  }

  /**
   * Stop intercepting console methods
   */
  stop(): void {
    if (!this.isActive) return;

    this.originalMethods.forEach((original, method) => {
      console[method] = original;
    });

    this.originalMethods.clear();
    this.isActive = false;
  }

  /**
   * Capture a console log entry
   */
  private capture(level: ConsoleMethod, args: any[]): void {
    const entry: ConsoleLogEntry = {
      level,
      args: this.serializeArgs(args),
      timestamp: Date.now(),
    };

    this.logs.push(entry);

    // Maintain size limit
    if (this.logs.length > this.maxSize) {
      this.logs.shift();
    }
  }

  /**
   * Serialize console arguments
   */
  private serializeArgs(args: any[]): any[] {
    return args.map((arg) => {
      if (arg === null) return null;
      if (arg === undefined) return undefined;
      if (typeof arg === "string") return arg;
      if (typeof arg === "number") return arg;
      if (typeof arg === "boolean") return arg;
      if (arg instanceof Error) {
        return {
          name: arg.name,
          message: arg.message,
          stack: arg.stack,
        };
      }
      // For objects, try to stringify
      try {
        return JSON.parse(JSON.stringify(arg));
      } catch {
        return String(arg);
      }
    });
  }

  /**
   * Collect all console logs
   */
  collect(): ConsoleLogEntry[] {
    return [...this.logs];
  }

  /**
   * Clear all console logs
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Get the current number of logs
   */
  size(): number {
    return this.logs.length;
  }
}
