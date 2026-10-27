/**
 * Server process handlers for graceful shutdown
 */

import type { Logger } from "../core/logger.js";

// Conventional shell exit status for a process ended by a signal (128 + n).
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Register process signal handlers for graceful shutdown. On SIGTERM or
 * SIGINT the logger logs the signal, flushes once (nothing is logged after
 * that flush, so no event is left queued) and exits with 128 + the signal
 * number (143 or 130).
 */
export function registerProcessHandlers(logger: Logger): () => void {
  if (typeof process === "undefined" || typeof process.on !== "function") {
    throw new Error(
      "registerProcessHandlers can only be used in Node.js environments"
    );
  }

  let shuttingDown = false;

  const shutdownHandler = (signal: string) => async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info(`Received ${signal}, flushing logs...`);

    try {
      await logger.flush();
    } catch (error) {
      console.error("[logfn] Failed to flush on shutdown", error);
    } finally {
      process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    }
  };

  const sigtermHandler = shutdownHandler("SIGTERM");
  const sigintHandler = shutdownHandler("SIGINT");

  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);

  // Return cleanup function
  return () => {
    process.off("SIGTERM", sigtermHandler);
    process.off("SIGINT", sigintHandler);
  };
}
