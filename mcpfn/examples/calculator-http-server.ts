import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import createCalculatorServer from "./calculator-server.js";

const MAX_BODY_BYTES = 1_048_576;

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

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413, { connection: "close" }).end("Payload too large");
        request.destroy();
        return;
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
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
