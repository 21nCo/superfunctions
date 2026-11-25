import { errorResponse } from "./errors.js";
import type { DatafnLogger } from "../logger.js";

/**
 * Check payload size against Content-Length header.
 * Returns an error Response if over limit, or null if OK.
 */
export function checkPayloadLimit(req: Request, maxBytes: number): Response | null {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const length = parseInt(contentLength, 10);
    if (!isNaN(length) && length > maxBytes) {
      return errorResponse({
        code: "LIMIT_EXCEEDED",
        message: "Request payload exceeds maximum size",
        details: { path: "$", max: maxBytes },
      }, 413);
    }
  }
  return null;
}

export function payloadTooLarge(maxBytes: number): Response {
  return errorResponse({
    code: "LIMIT_EXCEEDED",
    message: "Request payload exceeds maximum size",
    details: { path: "$", max: maxBytes },
  }, 413);
}

/**
 * Read a request body under maxBytes, stopping as soon as the stream exceeds it.
 * A Content-Length over the limit is rejected before the body is read.
 */
export async function readLimitedBody(
  req: Request,
  maxBytes: number,
  logger?: DatafnLogger,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: Response }> {
  const headerCheck = checkPayloadLimit(req, maxBytes);
  if (headerCheck) {
    return { ok: false, response: headerCheck };
  }
  if (req.body == null) {
    return { ok: true, bytes: new Uint8Array() };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (req.bodyUsed) throw new TypeError("Request body already consumed");
    const reader = req.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          // A tee or an async producer can delay cancellation beyond the response.
          void reader.cancel("request body limit exceeded").catch(() => undefined);
          return { ok: false, response: payloadTooLarge(maxBytes) };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    logger?.warn("Failed to read request body", { error: String(error), operation: "readBody" });
    return {
      ok: false,
      response: errorResponse({
        code: "DFQL_INVALID",
        message: "Failed to read request body",
        details: { path: "$" },
      }, 400),
    };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Read and validate request body size.
 * Returns the body text on success, or an error Response on failure.
 */
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
  logger?: DatafnLogger,
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  const read = await readLimitedBody(req, maxBytes, logger);
  if (!read.ok) return read;
  return { ok: true, body: new TextDecoder().decode(read.bytes) };
}

