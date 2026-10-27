/**
 * Console sink for structured logging
 */

import type { LogEvent, LogLevel, Sink } from "../types.js";

/**
 * Console sink options
 */
export interface ConsoleSinkOptions {
  /** Enable colored output (default: true in dev, false in prod) */
  color?: boolean;

  /** Output as JSON (default: false in dev, true in prod) */
  json?: boolean;

  /** Custom level colors */
  levelColors?: Partial<Record<LogLevel, string>>;
}

/**
 * Default ANSI color codes for log levels
 */
const DEFAULT_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m", // Gray
  debug: "\x1b[36m", // Cyan
  info: "\x1b[32m", // Green
  warn: "\x1b[33m", // Yellow
  error: "\x1b[31m", // Red
  fatal: "\x1b[35m", // Magenta
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

/**
 * Format timestamp for pretty printing
 */
function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString("en-US", { hour12: false });
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${time}.${ms}`;
}

/**
 * Format log event for pretty console output
 */
function formatPretty(
  event: LogEvent,
  useColor: boolean,
  colors: Record<LogLevel, string>
): string {
  const color = useColor ? colors[event.level] : "";
  const reset = useColor ? RESET : "";
  const bold = useColor ? BOLD : "";
  const dim = useColor ? DIM : "";

  const parts: string[] = [];

  // Timestamp
  parts.push(`${dim}${formatTimestamp(event.ts)}${reset}`);

  // Level (colored and padded)
  const levelStr = event.level.toUpperCase().padEnd(5);
  parts.push(`${color}${levelStr}${reset}`);

  // Name
  parts.push(`${bold}[${event.name}]${reset}`);

  // Message
  parts.push(event.msg);

  let line = parts.join(" ");

  // Context (if present)
  if (event.ctx && Object.keys(event.ctx).length > 0) {
    const ctxStr = JSON.stringify(event.ctx);
    line += ` ${dim}${ctxStr}${reset}`;
  }

  // Tags (if present)
  if (event.tags && event.tags.length > 0) {
    const tagsStr = event.tags.map((t) => `#${t}`).join(" ");
    line += ` ${dim}${tagsStr}${reset}`;
  }

  // IDs (if present)
  const ids: string[] = [];
  if (event.traceId) ids.push(`trace=${event.traceId.slice(0, 8)}`);
  if (event.requestId) ids.push(`req=${event.requestId.slice(0, 8)}`);
  if (ids.length > 0) {
    line += ` ${dim}(${ids.join(" ")})${reset}`;
  }

  return line;
}

/**
 * Get the appropriate console method for a log level
 */
function getConsoleMethod(level: LogLevel): "error" | "warn" | "log" {
  if (level === "error" || level === "fatal") {
    return "error";
  }
  if (level === "warn") {
    return "warn";
  }
  return "log";
}

/**
 * Create a console sink
 */
export function sinkConsole(options: ConsoleSinkOptions = {}): Sink {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const useColor = options.color ?? (env !== undefined && env.NODE_ENV !== "production");
  const useJson = options.json ?? env?.NODE_ENV === "production";
  const colors = { ...DEFAULT_COLORS, ...options.levelColors };

  const sink: Sink = function consoleSink(batch: LogEvent[]) {
    for (const event of batch) {
      const method = getConsoleMethod(event.level);

      if (useJson) {
        console[method](JSON.stringify(event));
      } else {
        const formatted = formatPretty(event, useColor, colors);
        console[method](formatted);
      }
    }
  };

  return sink;
}
