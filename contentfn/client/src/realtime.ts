import type {
  ContentfnEnvelope,
  CfqlQuery,
  CfqlResultPage,
} from "@contentfn/core";
import type { ContentfnClientOptions } from "./index.js";

export interface ContentfnRealtimeEvent {
  type: "event";
  eventId: string;
  dataset: string;
  timestamp: string;
  eventType: string;
  document?: { _id: string; _type?: string; _rev?: string };
  actor?: { subject: string };
  /** Present for query.snapshot and query.updated events. */
  queryResult?: CfqlResultPage;
}
/** Fetch-based SSE supports bearer headers in browsers and cancels when iteration ends. */
export async function* streamContentfnEvents(
  options: ContentfnClientOptions,
  input: {
    dataset: string;
    docId?: string;
    query?: CfqlQuery;
    signal?: AbortSignal;
  },
): AsyncGenerator<ContentfnEnvelope<ContentfnRealtimeEvent>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const url = new URL(
      `${options.baseUrl.replace(/\/$/, "")}/contentfn/events`,
    );
    url.searchParams.set("dataset", input.dataset);
    if (input.docId) url.searchParams.set("docId", input.docId);
    if (input.query) url.searchParams.set("query", JSON.stringify(input.query));
    const headers = new Headers(
      typeof options.headers === "function"
        ? await options.headers()
        : options.headers,
    );
    headers.set("Accept", "text/event-stream");
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      headers,
      credentials: options.credentials,
      signal: input.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const result =
        (await response.json()) as ContentfnEnvelope<ContentfnRealtimeEvent>;
      if (
        result.ok === false &&
        result.error &&
        typeof result.error.code === "string"
      ) {
        yield result;
        return;
      }
      throw new Error("Invalid event response");
    }
    if (
      !response.headers.get("Content-Type")?.startsWith("text/event-stream") ||
      !response.body
    )
      throw new Error("Invalid event stream");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffered += decoder.decode(chunk.value, { stream: true });
      if (buffered.length > 1_048_576) throw new Error("Event exceeds limit");
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as ContentfnRealtimeEvent;
        if ((event as unknown as { type: string }).type === "error") {
          const failure = event as unknown as {
            code?: unknown;
            message?: unknown;
          };
          if (
            typeof failure.code !== "string" ||
            typeof failure.message !== "string"
          )
            throw new Error("Invalid event error");
          yield {
            ok: false,
            error: {
              code: failure.code as "REALTIME_NOT_AVAILABLE",
              message: failure.message,
              details: {},
            },
          };
          return;
        }
        if (
          event.type !== "event" ||
          typeof event.eventId !== "string" ||
          typeof event.dataset !== "string" ||
          typeof event.timestamp !== "string" ||
          typeof event.eventType !== "string"
        )
          throw new Error("Invalid event");
        yield { ok: true, result: event };
      }
    }
  } catch {
    if (!input.signal?.aborted)
      yield {
        ok: false,
        error: {
          code: "REALTIME_NOT_AVAILABLE",
          message: "Realtime stream could not be completed",
          details: {},
        },
      };
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}
