import { randomUUID } from "node:crypto";
import type { CfqlQuery, ContentfnEnvelope } from "@contentfn/core";
import { err, validateDatasetName } from "@contentfn/core";
import { checkAuthorize, type AuthorizeFn } from "../auth/authorize.js";
import type { RealtimeServer } from "./server.js";
import type { ContentfnLogger } from "../logging/logger.js";

/** Authorized SSE subscriptions with bounded buffering and connection presence. */
export async function eventStream(
  request: Request,
  config: {
    realtime: RealtimeServer;
    authorize?: AuthorizeFn;
    context?: (request: Request) => unknown | Promise<unknown>;
    logger: ContentfnLogger;
    query?: (
      query: CfqlQuery,
      context: unknown,
    ) => Promise<ContentfnEnvelope<unknown>>;
  },
): Promise<Response> {
  const url = new URL(request.url);
  const dataset = url.searchParams.get("dataset") ?? "";
  const docId = url.searchParams.get("docId") ?? undefined;
  if (!validateDatasetName(dataset).ok || (docId !== undefined && !docId))
    return Response.json(
      err(
        "VALIDATION_FAILED",
        "A valid dataset and optional document ID are required",
        {},
      ),
      { status: 400 },
    );
  const queryText = url.searchParams.get("query");
  let query: CfqlQuery | undefined;
  if (queryText !== null) {
    if (Buffer.byteLength(queryText, "utf8") > 16384)
      return Response.json(
        err("PAYLOAD_TOO_LARGE", "Subscription query exceeds 16KiB", {}),
        { status: 413 },
      );
    try {
      query = JSON.parse(queryText);
    } catch {
      return Response.json(
        err("QUERY_INVALID", "Invalid subscription query", {}),
        { status: 400 },
      );
    }
    if (
      !query ||
      typeof query !== "object" ||
      Array.isArray(query) ||
      query.dataset !== dataset ||
      docId !== undefined
    )
      return Response.json(
        err(
          "QUERY_INVALID",
          "Query dataset must match subscription dataset; docId and query are mutually exclusive",
          {},
        ),
        { status: 400 },
      );
    if (!config.query)
      return Response.json(
        err(
          "REALTIME_NOT_AVAILABLE",
          "Query subscriptions are unavailable",
          {},
        ),
        { status: 400 },
      );
  }
  const context = config.context ? await config.context(request) : request;
  const denied = await checkAuthorize(
    config.authorize,
    context,
    "realtime.subscribe",
    { dataset, docId, ...(query ? { query } : {}) },
  );
  if (denied) return Response.json(denied, { status: 403 });
  if (query) {
    const initial = await config.query!(query, context);
    if (!initial.ok)
      return Response.json(initial, {
        status: initial.error.code === "PERMISSION_DENIED" ? 403 : 400,
      });
    if (Buffer.byteLength(JSON.stringify(initial.result), "utf8") > 1_000_000)
      return Response.json(
        err(
          "PAYLOAD_TOO_LARGE",
          "Query snapshot exceeds realtime frame limit",
          {},
        ),
        { status: 413 },
      );
  }
  const subject =
    context &&
    typeof context === "object" &&
    "subject" in context &&
    typeof context.subject === "string"
      ? context.subject
      : undefined;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const send = (message: unknown) => {
          if (closed) return;
          const frame = encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
          if (
            frame.byteLength > 1_048_576 ||
            (controller.desiredSize ?? 0) <= 0
          ) {
            cleanup();
            return;
          }
          controller.enqueue(frame);
        };
        let refreshing = false,
          dirty = false,
          fingerprint: string | undefined;
        const refresh = async () => {
          dirty = true;
          if (refreshing || closed) return;
          refreshing = true;
          try {
            while (dirty && !closed) {
              dirty = false;
              const result = await config.query!(query!, context);
              if (closed) return;
              if (!result.ok) {
                send({ type: "error", ...result.error });
                cleanup();
                return;
              }
              const next = JSON.stringify(result.result);
              if (Buffer.byteLength(next, "utf8") > 1_000_000) {
                send({
                  type: "error",
                  code: "PAYLOAD_TOO_LARGE",
                  message: "Query snapshot exceeds realtime frame limit",
                });
                cleanup();
                return;
              }
              if (next !== fingerprint) {
                send({
                  type: "event",
                  eventId: randomUUID(),
                  dataset,
                  timestamp: new Date().toISOString(),
                  eventType:
                    fingerprint === undefined
                      ? "query.snapshot"
                      : "query.updated",
                  queryResult: result.result,
                });
                fingerprint = next;
              }
            }
          } catch {
            send({
              type: "error",
              code: "REALTIME_NOT_AVAILABLE",
              message: "Query subscription refresh failed",
            });
            cleanup();
          } finally {
            refreshing = false;
          }
        };
        const connection = config.realtime.createConnection((message) => {
          if (query) {
            if (
              message.type === "event" &&
              !message.eventType.startsWith("presence.")
            )
              void refresh();
          } else send(message);
        }, context);
        cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          request.signal.removeEventListener("abort", cleanup);
          connection.disconnect();
          if (subject)
            config.realtime.broadcast({
              eventId: randomUUID(),
              type: "presence.leave",
              dataset,
              docId,
              actor: { subject },
              timestamp: new Date().toISOString(),
            });
          try {
            config.logger.logMutation({
              action: "realtime.unsubscribe",
              dataset,
              docId,
              actor: subject,
            });
            config.logger.logMutation({
              action: "realtime.disconnect",
              dataset,
              docId,
              actor: subject,
            });
          } catch {}
          try {
            controller.close();
          } catch {}
        };
        config.realtime.router.subscribe(connection.id, { dataset, docId });
        controller.enqueue(encoder.encode(": connected\n\n"));
        request.signal.addEventListener("abort", cleanup, { once: true });
        if (request.signal.aborted) {
          cleanup();
          return;
        }
        if (subject)
          config.realtime.broadcast({
            eventId: randomUUID(),
            type: "presence.join",
            dataset,
            docId,
            actor: { subject },
            timestamp: new Date().toISOString(),
          });
        try {
          config.logger.logMutation({
            action: "realtime.connect",
            dataset,
            docId,
            actor: subject,
          });
          config.logger.logMutation({
            action: "realtime.subscribe",
            dataset,
            docId,
            actor: subject,
          });
        } catch {}
        if (query) void refresh();
        heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? 0) <= 0) {
            cleanup();
            return;
          }
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15_000);
        heartbeat.unref?.();
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 64 },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
