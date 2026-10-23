import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { Router } from "@superfunctions/http";

/** Compatibility for the original bare Node handler; framework users consume router directly. */
export function nodeHandler(router: Router) {
  return async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    const onClose = () => abort.abort();
    outgoing.once("close", onClose);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const init: RequestInit & { duplex?: "half" } = { method: incoming.method, headers, signal: abort.signal };
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const request = new Request(new URL(incoming.url ?? "/", "http://localhost"), init);
      const response = await router.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (!outgoing.destroyed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!outgoing.write(Buffer.from(chunk.value))) await once(outgoing, "drain", { signal: abort.signal });
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "Request could not be completed", details: {} } }));
    } finally { outgoing.off("close", onClose); }
  };
}
