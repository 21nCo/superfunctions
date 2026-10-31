/**
 * Logger factory functions and presets
 */

import { Logger } from "./logger.js";
import type { LogLevel, LoggerOptions, Sink } from "../types.js";
import { sinkConsole } from "../sinks/console.js";
import { sinkHttp } from "../sinks/http.js";
import { redactSecFn } from "../pipeline/redact.js";

/**
 * Create a logger with the given options. Without sinks it writes to the
 * local console only.
 */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}

/**
 * Create a development logger with console output and colors
 */
export function devLogger(name = "app"): Logger {
  return new Logger({
    name,
    level: "debug",
    sinks: [sinkConsole({ color: true, json: false })],
  });
}

/**
 * Create a server logger: redacted JSON console output, plus an HTTP sink
 * only when a url is given.
 */
export function serverLogger(opts: { name: string; url?: string; level?: LogLevel }): Logger {
  const sinks: Sink[] = [sinkConsole({ json: true, color: false })];
  if (opts.url) {
    sinks.push(sinkHttp({ url: opts.url }));
  }

  return new Logger({
    name: opts.name,
    level: opts.level ?? "info",
    pipeline: [redactSecFn()],
    sinks,
  });
}
