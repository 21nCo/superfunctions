/**
 * Server process handlers for graceful shutdown
 */

import type { Logger } from "../core/logger.js";

/**
 * Register process signal handlers for graceful shutdown
 */
export function registerProcessHandlers(logger: Logger): () => void {
  if (typeof process === "undefined") {
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
    let exitCode = 0;
    try {
      logger.info(`Received ${signal}, flushing logs...`);
      await logger.flush();
    } catch {
      exitCode = 1;
      console.error("[logfn] Failed to flush on shutdown");
    } finally {
      process.exit(exitCode);
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
