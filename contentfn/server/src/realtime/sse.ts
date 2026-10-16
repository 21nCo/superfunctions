import { randomUUID } from "node:crypto";
import { err, validateDatasetName } from "@contentfn/core";
import { checkAuthorize, type AuthorizeFn } from "../auth/authorize.js";
import type { RealtimeServer } from "./server.js";
import type { ContentfnLogger } from "../logging/logger.js";

/** Authorized SSE subscriptions with bounded buffering and connection presence. */
export async function eventStream(request: Request, config: { realtime: RealtimeServer; authorize?: AuthorizeFn; context?: (request: Request) => unknown | Promise<unknown>; logger: ContentfnLogger }): Promise<Response> {
  const url = new URL(request.url);
  const dataset = url.searchParams.get("dataset") ?? "";
  const docId = url.searchParams.get("docId") ?? undefined;
  if (!validateDatasetName(dataset).ok || (docId !== undefined && (!docId || docId.length > 500))) return Response.json(err("VALIDATION_FAILED", "A valid dataset and optional document ID are required", {}), { status: 400 });
  const context = config.context ? await config.context(request) : request;
  const denied = await checkAuthorize(config.authorize, context, "realtime.subscribe", { dataset, docId });
  if (denied) return Response.json(denied, { status: 403 });
  const subject = context && typeof context === "object" && "subject" in context && typeof context.subject === "string" ? context.subject : undefined;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const connection = config.realtime.createConnection(message => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) <= 0) { cleanup(); return; }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      }, context);
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", cleanup);
        connection.disconnect();
        if (subject) config.realtime.broadcast({ eventId: randomUUID(), type: "presence.leave", dataset, docId, actor: { subject }, timestamp: new Date().toISOString() });
        try {
          config.logger.logMutation({ action: "realtime.unsubscribe", dataset, docId, actor: subject });
          config.logger.logMutation({ action: "realtime.disconnect", dataset, docId, actor: subject });
        } catch {}
        try { controller.close(); } catch {}
      };
      config.realtime.router.subscribe(connection.id, { dataset, docId });
      controller.enqueue(encoder.encode(": connected\n\n"));
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) { cleanup(); return; }
      if (subject) config.realtime.broadcast({ eventId: randomUUID(), type: "presence.join", dataset, docId, actor: { subject }, timestamp: new Date().toISOString() });
      try {
        config.logger.logMutation({ action: "realtime.connect", dataset, docId, actor: subject });
        config.logger.logMutation({ action: "realtime.subscribe", dataset, docId, actor: subject });
      } catch {}
      heartbeat = setInterval(() => {
        if ((controller.desiredSize ?? 0) <= 0) { cleanup(); return; }
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      heartbeat.unref?.();
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
}
