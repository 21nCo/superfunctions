import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import createCalculatorServer from "./calculator-server.js";

const MAX_BODY_BYTES = 1_048_576;

/** The request body, or undefined once it exceeds MAX_BODY_BYTES (the rest is discarded). */
function readBody(request: IncomingMessage): Promise<ReturnType<typeof Buffer.concat> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        request.off("data", onData);
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(buffer);
    };
    request.on("data", onData);
    request.once("end", () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

const mcp = createCalculatorServer();
// The handler refuses browser requests whose Origin is not listed (DNS
// rebinding); the Host check below also refuses rebound names that send none.
const handler = await mcp.createWebStandardHandler({ enableJsonResponse: true });

const httpServer = createServer(async (request, response) => {
  try {
    // A local server answers only to loopback names. A DNS-rebinding page
    // reaches 127.0.0.1 under its own host name, which this refuses.
    const host = request.headers.host ?? "";
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) {
      response.writeHead(403).end("Forbidden host");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/mcp") {
      response.writeHead(404).end("Not found");
      return;
    }

    const body = await readBody(request);
    if (!body) {
      // Let the queued 413 flush; "connection: close" ends the socket after it.
      response.writeHead(413, { connection: "close" }).end("Payload too large");
      return;
    }
    const webRequest = new Request(url, {
      method: request.method,
      headers: new Headers(
        Object.entries(request.headers).flatMap(([key, value]) =>
          Array.isArray(value)
            ? value.map((entry) => [key, entry] as [string, string])
            : value === undefined
              ? []
              : [[key, value] as [string, string]],
        ),
      ),
      ...(body.length > 0 ? { body } : {}),
    });
    const webResponse = await handler(webRequest);
    response.writeHead(
      webResponse.status,
      Object.fromEntries(webResponse.headers.entries()),
    );
    if (!webResponse.body) {
      response.end();
      return;
    }
    const reader = webResponse.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(Buffer.from(chunk.value));
    }
    response.end();
  } catch {
    if (response.headersSent) {
      response.destroy();
    } else {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("Internal Server Error");
    }
  }
});

await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});

const address = httpServer.address() as AddressInfo;
process.stdout.write(`http://127.0.0.1:${address.port}/mcp\n`);

const close = async () => {
  await mcp.close().catch(() => undefined);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
