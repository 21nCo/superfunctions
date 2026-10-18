/**
 * Browser error capture utilities
 */

import type { Logger } from "../core/logger.js";

/**
 * Capture browser window errors and unhandled promise rejections
 */
export function captureBrowserErrors(logger: Logger): () => void {
  if (typeof window === "undefined") {
    throw new Error(
      "captureBrowserErrors can only be used in browser environments"
    );
  }

  const errorHandler = (event: ErrorEvent) => {
    logger.error(
      "Uncaught error",
      {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      },
      ["browser-error", "uncaught"]
    );
  };

  const rejectionHandler = (event: PromiseRejectionEvent) => {
    logger.error(
      "Unhandled promise rejection",
      {
        reason:
          event.reason instanceof Error
            ? {
                message: event.reason.message,
                stack: event.reason.stack,
              }
            : event.reason,
      },
      ["browser-error", "unhandled-rejection"]
    );
  };

  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectionHandler);

  // Return cleanup function
  return () => {
    window.removeEventListener("error", errorHandler);
    window.removeEventListener("unhandledrejection", rejectionHandler);
  };
}

/**
 * Attach flush hooks for browser unload events
 */
export function attachFlushHooks(logger: Logger): () => void {
  if (typeof window === "undefined") {
    throw new Error(
      "attachFlushHooks can only be used in browser environments"
    );
  }

  const visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      logger.flush().catch((error) => {
        console.error("[logfn] Failed to flush on visibility change", error);
      });
    }
  };

  const unloadHandler = () => {
    // Try to flush synchronously (may not complete)
    logger.flush().catch(() => {
      // Best effort
    });
  };

  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", unloadHandler);

  return () => {
    document.removeEventListener("visibilitychange", visibilityHandler);
    window.removeEventListener("beforeunload", unloadHandler);
  };
}
