/**
 * WatchFn ingest handler
 */

import { DEFAULT_VERSION, MAX_EVENT_SIZE, type LogEvent } from "../types.js";
import { createRouter, type Router } from "@superfunctions/http";
import { isValidLogEvent } from "../validation.js";

export interface WatchLogsHandlerOptions {
  /** Resolve only after the entire batch is durably accepted. May be retried after failure. */
  ingest?: (events: LogEvent[], request: Request) => void | Promise<void>;

  /** Maximum UTF-8 request body size (default: 8 MiB). */
  maxBodyBytes?: number;
  /** Authentication configuration */
  auth?:
    | {
        header: string;
        value: string;
      }
    | {
        verifyToken: (req: Request) => boolean | Promise<boolean>;
      };

  /** Maximum batch size (default: 500) */
  maxBatch?: number;
}

/**
 * Create a WatchFn logs ingest handler
 * Route: POST /watch/logs
 * Body: { events: LogEvent[] }
 */
export function watchLogsHandler(options: WatchLogsHandlerOptions = {}) {
  const { maxBatch = 500, maxBodyBytes = 8 * 1024 * 1024, auth, ingest } = options;
  for (const [name, value] of Object.entries({ maxBatch, maxBodyBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const error = (message: string, status: number) => new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json" },
  });

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405, headers: { "Content-Type": "application/json", Allow: "POST" },
      });
    }
    // Verify authentication
    if (auth) {
      let authorized = false;

      if ("verifyToken" in auth) {
        try {
          authorized = (await auth.verifyToken(req)) === true;
        } catch {
          return error("Authentication unavailable", 503);
        }
      } else {
        const headerValue = req.headers.get(auth.header);
        authorized = headerValue === auth.value;
      }

      if (!authorized) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Parse body
    let body: unknown;
    try {
      const reader = req.body?.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBodyBytes) {
              await reader.cancel().catch(() => undefined);
              return error("Request body too large", 413);
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate schema
    if (!body || typeof body !== "object" || !("events" in body)) {
      return new Response(JSON.stringify({ error: "Missing events field" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { events } = body as { events: unknown };

    if (!Array.isArray(events)) {
      return new Response(
        JSON.stringify({ error: "Events must be an array" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Check batch size
    if (events.length > maxBatch) {
      return new Response(
        JSON.stringify({
          error: "Batch too large",
          maxBatch,
          received: events.length,
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Validate each event has required fields
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        return new Response(JSON.stringify({ error: "Invalid event format" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!isValidLogEvent(event)) {
        return new Response(
          JSON.stringify({ error: "Event missing required fields" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      if (event.version !== DEFAULT_VERSION) return error("Unsupported event version", 400);
      if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_EVENT_SIZE) {
        return error("Event too large", 413);
      }
    }

    const accepted = events.length;
    if (!ingest) return error("Log ingestion is not configured", 503);
    try {
      await ingest(events as LogEvent[], req);
    } catch {
      return error("Log ingestion failed", 503);
    }

    return new Response(JSON.stringify({ accepted }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };
}


/** Shared HTTP router; mount it using the consumer's framework adapter. */
export function watchLogsRouter(
  options: WatchLogsHandlerOptions & { path?: string; basePath?: string } = {}
): Router {
  const { path = "/watch/logs", basePath, ...handlerOptions } = options;
  return createRouter({
    basePath,
    routes: [{
      method: "POST",
      path,
      handler: watchLogsHandler(handlerOptions),
      meta: { openapi: { operationId: "ingestLogs", summary: "Accept structured log events", tags: ["logs"] } },
    }],
  });
}
