/**
 * DFN-25: rate limiting matches SECURITY.md.
 * It applies only when enabled, and a disabled or omitted limiter does not reject.
 */
import { afterEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../src/server.js";

const schema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [{ name: "title", type: "string", required: true }],
    },
  ],
  relations: [],
};

describe("request check coverage", () => {
  const servers: Array<{ close: () => Promise<void> | void }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close?.();
    }
  });

  async function start(rateLimit?: { enabled: boolean; maxRequests?: number; windowSeconds?: number }) {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema,
      database: db,
      ...(rateLimit ? { rateLimit } : {}),
    });
    servers.push(server);
    return server;
  }

  async function query(server: Awaited<ReturnType<typeof start>>) {
    const response = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "task" }),
      }),
      {},
    );
    const body = await response.json();
    return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
  }

  it("does not rate limit when the limiter is omitted", async () => {
    const server = await start();
    for (let i = 0; i < 3; i++) {
      const result = await query(server);
      expect(result.status).not.toBe(429);
    }
  });

  it("does not rate limit when the limiter is disabled", async () => {
    const server = await start({ enabled: false });
    for (let i = 0; i < 3; i++) {
      const result = await query(server);
      expect(result.status).not.toBe(429);
    }
  });

  it("returns RATE_LIMITED when the limiter is enabled", async () => {
    const server = await start({ enabled: true, maxRequests: 1, windowSeconds: 60 });
    const first = await query(server);
    expect(first.status).toBe(200);
    const second = await query(server);
    expect(second.status).toBe(429);
    expect(second.body.ok).toBe(false);
    expect(second.body.error.code).toBe("RATE_LIMITED");
    expect(second.body.error.message).toBe("Too many requests");
    expect(second.retryAfter).toBe("60");
  });
});
