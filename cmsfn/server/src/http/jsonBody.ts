import type { IncomingMessage } from "node:http";
import { err, type CmsfnEnvelope } from "cmsfn";
import { createRouteContext, PayloadTooLargeError } from "@superfunctions/http";

/** Bounded JSON object parsing without destroying the socket before an error response. */
export async function readJsonObject(req: IncomingMessage, maxBodyBytes: number): Promise<CmsfnEnvelope<Record<string, unknown>>> {
  try {
    // Returning this iterator leaves the socket alive so an oversized request
    // can receive its error envelope. The shared parser owns byte accounting.
    const iterator = req.iterator({ destroyOnReturn: false });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const item = await iterator.next();
        if (item.done) controller.close();
        else controller.enqueue(typeof item.value === "string" ? Buffer.from(item.value) : item.value);
      },
      async cancel() { await iterator.return?.(); },
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (req.headers["content-length"] !== undefined) {
      headers.set("content-length", req.headers["content-length"]);
    }
    const request = new Request("http://cmsfn.local/request", {
      method: "POST", headers, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const body: unknown = await createRouteContext(request, {}, { maxBodyBytes: maxBodyBytes }).json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return err("VALIDATION_FAILED", "Request body must be a JSON object");
    }
    return { ok: true, result: body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return err("PAYLOAD_TOO_LARGE", `Request exceeds ${maxBodyBytes} bytes`);
    }
    return err("VALIDATION_FAILED", "Invalid JSON request body");
  }
}
