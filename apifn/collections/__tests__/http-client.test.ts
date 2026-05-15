import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createCookieJar, createFetchHttpClient } from "../src/index.js";

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
  };
}

describe("fetch HTTP client", () => {
  it("persists cookies across requests", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/login") {
        res.writeHead(200, {
          "set-cookie": ["session=abc; Path=/; HttpOnly"],
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(req.headers.cookie === "session=abc" ? 200 : 401);
      res.end(req.headers.cookie ?? "");
    });

    try {
      const client = createFetchHttpClient({ cookieJar: createCookieJar() });
      await client.send({
        method: "POST",
        url: `${server.baseUrl}/login`,
        headers: {},
      });
      const session = await client.send({
        method: "GET",
        url: `${server.baseUrl}/session`,
        headers: {},
      });

      expect(session.status).toBe(200);
      expect(session.body).toBe("session=abc");
    } finally {
      await server.close();
    }
  });

  it("ignores cookies for unrelated domains", async () => {
    const jar = createCookieJar();

    jar.storeFromResponse("http://api.example.com/login", [
      "session=bad; Domain=evil.example.com; Path=/",
      "local=ok; Domain=.example.com; Path=/",
    ]);

    expect(jar.get("session", "http://evil.example.com/")).toBeUndefined();
    expect(jar.get("local", "http://api.example.com/")).toBe("ok");
  });

  it("follows redirects and records redirect chain", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/finish" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("done");
    });

    try {
      const client = createFetchHttpClient();
      const result = await client.send({
        method: "GET",
        url: `${server.baseUrl}/start`,
        headers: {},
        followRedirects: true,
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe("done");
      expect(result.redirects).toEqual([
        expect.objectContaining({
          status: 302,
          url: `${server.baseUrl}/start`,
          location: `${server.baseUrl}/finish`,
        }),
      ]);
    } finally {
      await server.close();
    }
  });

  it("fails when max redirects is exceeded", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    });

    try {
      const client = createFetchHttpClient();
      await expect(client.send({
        method: "GET",
        url: `${server.baseUrl}/loop`,
        headers: {},
        followRedirects: true,
        maxRedirects: 1,
      })).rejects.toThrow("Maximum redirects exceeded");
    } finally {
      await server.close();
    }
  });
});
