/**
 * Logger factory functions and presets
 */

import { Logger } from "./logger.js";
import type { LoggerOptions } from "../types.js";
import { sinkConsole } from "../sinks/console.js";
import { sinkHttp } from "../sinks/http.js";

/**
 * Create a logger with the given options
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
 * Create a server logger with optional HTTP sink
 */
export function serverLogger(opts: {
  name: string;
  url?: string;
  level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}): Logger {
  const sinks = [sinkConsole({ json: true })];

  if (opts.url) {
    sinks.push(sinkHttp({ url: opts.url }));
  }

  return new Logger({
    name: opts.name,
    level: opts.level ?? "info",
    sinks,
  });
}
