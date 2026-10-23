/**
 * WatchFn ingest handler
 */

export interface WatchLogsHandlerOptions {
  /** Authentication configuration */
  auth?:
    | {
        header: string;
        value: string;
      }
    | {
        verifyToken: (req: Request) => boolean;
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
  const { maxBatch = 500, auth } = options;

  return async (req: Request): Promise<Response> => {
    // Verify authentication
    if (auth) {
      let authorized = false;

      if ("verifyToken" in auth) {
        authorized = auth.verifyToken(req);
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
      body = await req.json();
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
      if (!event || typeof event !== "object") {
        return new Response(JSON.stringify({ error: "Invalid event format" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const e = event as Record<string, unknown>;
      if (!e.ts || !e.level || !e.msg || !e.name || !e.version) {
        return new Response(
          JSON.stringify({ error: "Event missing required fields" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // TODO: In a real implementation, this would store events in WatchFn
    // For now, just acknowledge receipt

    return new Response(JSON.stringify({ accepted: events.length }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };
}
