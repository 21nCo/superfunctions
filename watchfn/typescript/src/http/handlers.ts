import { createRouteContext, PayloadTooLargeError } from "@superfunctions/http";
import { WatchFn } from "../core/watch-fn";
import { QueryValidationError } from "../query/query-engine";

export class HttpHandlers {
  private watch: WatchFn;

  constructor(watch: WatchFn) {
    this.watch = watch;
  }

  async health() {
    return new Response(JSON.stringify({ status: "ok", version: "0.1.0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async ingest(request: Request) {
    const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
    if (!this.watch.authorizeIngest(request)) return reply({ error: "Unauthorized" }, 401);
    let body: unknown;
    try {
      body = await createRouteContext(request, {}, { maxBodyBytes: 8 * 1024 * 1024 }).json();
    } catch (error) {
      const tooLarge = error instanceof PayloadTooLargeError;
      return reply({ error: tooLarge ? "Request body too large" : "Invalid JSON" }, tooLarge ? 413 : 400);
    }
    const events: unknown = Array.isArray(body) ? body
      : body && typeof body === "object" && "events" in body ? body.events : [body];
    if (!Array.isArray(events) || events.length === 0 || events.length > 500) return reply({ error: "Invalid batch" }, 400);
    const encoder = new TextEncoder();
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) return reply({ error: "Invalid event" }, 400);
      const value = event as Record<string, unknown>;
      if (typeof value.name !== "string" || !value.name.trim()) return reply({ error: "Event name is required" }, 400);
      if (encoder.encode(JSON.stringify(value)).byteLength > 64 * 1024) return reply({ error: "Event too large" }, 413);
    }
    try {
      await this.watch.ingest(events as Record<string, unknown>[]);
    } catch {
      return reply({ error: "Storage unavailable" }, 503);
    }
    return reply({ accepted: events.length }, 202);
  }

  async query(request: Request) {
    const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
    if (!this.watch.authorizeIngest(request)) return reply({ error: "Unauthorized" }, 401);
    let body: unknown;
    try {
      body = await createRouteContext(request, {}, { maxBodyBytes: 64 * 1024 }).json();
    } catch (error) {
      const tooLarge = error instanceof PayloadTooLargeError;
      return reply({ error: tooLarge ? "Request body too large" : "Invalid JSON" }, tooLarge ? 413 : 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply({ error: "Invalid query" }, 400);
    }
    try {
      // QueryEngine owns semantic validation for both programmatic and HTTP calls.
      const results = await this.watch.query(body);
      return reply({ results }, 200);
    } catch (error) {
      return error instanceof QueryValidationError
        ? reply({ error: "Invalid query" }, 400)
        : reply({ error: "Query unavailable" }, 503);
    }
  }
}
