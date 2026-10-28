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
 * number (143 or 130). A second signal while that flush is pending exits at
 * once with its own code.
 */
export function registerProcessHandlers(logger: Logger): () => void {
  if (typeof process === "undefined" || typeof process.on !== "function") {
    throw new Error(
      "registerProcessHandlers can only be used in Node.js environments"
    );
  }

  let shuttingDown = false;
  let exited = false;
  const exit = (signal: string) => {
    if (!exited) {
      exited = true;
      process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    }
  };

  const shutdownHandler = (signal: string) => async () => {
    if (shuttingDown) {
      // A repeated signal while the flush is pending exits at once, so a
      // sink whose flush never settles cannot make the process unkillable.
      exit(signal);
      return;
    }

    shuttingDown = true;
    logger.info(`Received ${signal}, flushing logs...`);

    try {
      await logger.flush();
    } catch (error) {
      console.error("[logfn] Failed to flush on shutdown", error);
    } finally {
      exit(signal);
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
