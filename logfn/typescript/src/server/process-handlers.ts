/**
 * Server process handlers for graceful shutdown
 */

import type { Logger } from "../core/logger.js";

/**
 * Register process signal handlers for graceful shutdown
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
      logger.info("Logs flushed successfully");
    } catch (error) {
      console.error("[logfn] Failed to flush on shutdown", error);
    } finally {
      process.exit(0);
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
