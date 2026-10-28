import { afterEach, describe, expect, it, vi } from "vitest";
import { McpFnRegistry, createMcpFnServer } from "../src/index.js";

const servers: ReturnType<typeof createMcpFnServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.useRealTimers();
});
function server() {
  const instance = createMcpFnServer({ info: { name: "limits", version: "1" }, registry: new McpFnRegistry() });
  servers.push(instance);
  return instance;
}
function request(id?: string, method = "POST") {
  return new Request("https://example.com/mcp", {
    method,
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(id ? { "mcp-session-id": id } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(id
      ? { jsonrpc: "2.0", id: 2, method: "ping" }
      : { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) } : {}),
  });
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
async function consume(response: Response) { await response.text(); return response; }
const owner = { authInfo: { token: "verified", clientId: "app", scopes: [], extra: { subject: "user" } } };

describe("stateful HTTP ownership and resource limits", () => {
  it("does not upgrade anonymous sessions into authenticated sessions", async () => {
    const handler = await server().createWebStandardHandler({ sessionIdGenerator: () => "anonymous", enableJsonResponse: true });
    await consume(await handler(request()));
    for (const method of ["POST", "GET", "DELETE"]) {
      expect((await consume(await handler(request("anonymous", method), owner))).status).toBe(404);
    }
    expect((await consume(await handler(request("anonymous")))).status).toBe(200);
  });

  it("binds equal subjects at distinct verified issuers to separate owners", async () => {
    const handler = await server().createWebStandardHandler({ sessionIdGenerator: () => "issuer-bound", enableJsonResponse: true });
    const issuerOwner = { authInfo: { ...owner.authInfo, extra: { subject: "user", issuer: "https://issuer-a.example" } } };
    await consume(await handler(request(), issuerOwner));
    for (const extra of [{ subject: "user", issuer: "https://issuer-b.example" }, { subject: "user" }, {}]) {
      expect((await consume(await handler(request("issuer-bound"), { authInfo: { ...owner.authInfo, extra } }))).status).toBe(404);
    }
    expect((await consume(await handler(request("issuer-bound"), issuerOwner))).status).toBe(200);
  });

  it("reserves live IDs before awaiting initialization hooks and never deletes a colliding owner", async () => {
    const started = deferred(), resume = deferred();
    const handler = await server().createWebStandardHandler({
      sessionIdGenerator: () => "same", enableJsonResponse: true,
      onsessioninitialized: async () => { started.resolve(); await resume.promise; },
    });
    const first = handler(request());
    await started.promise;
    const duplicate = await consume(await handler(request()));
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    resume.resolve();
    expect((await consume(await first)).status).toBe(200);
    expect((await consume(await handler(request("same")))).status).toBe(200);
  });

  it("counts pending initialization and frees its reservation after failed configuration", async () => {
    const started = deferred(), resume = deferred();
    let attempts = 0;
    const handler = await server().createWebStandardHandler({
      maxSessions: 1, sessionIdGenerator: () => "reserved", enableJsonResponse: true,
      configureRequestServer: async () => { if (++attempts === 1) { started.resolve(); await resume.promise; throw new Error("configuration failed"); } },
    });
    const first = handler(request());
    const rejected = expect(first).rejects.toThrow("configuration failed");
    await started.promise;
    expect((await consume(await handler(request()))).status).toBe(503);
    resume.resolve(); await rejected;
    expect((await consume(await handler(request()))).status).toBe(200);
  });

  it("keeps an active SSE response alive, then expires after its body is cancelled", async () => {
    vi.useFakeTimers();
    let id = 0;
    const handler = await server().createWebStandardHandler({ maxSessions: 1, idleTimeoutMs: 100, sessionIdGenerator: () => `id-${++id}`, enableJsonResponse: true });
    await consume(await handler(request()));
    const stream = await handler(request("id-1", "GET"));
    expect(stream.status).toBe(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await consume(await handler(request()))).status).toBe(503);
    await stream.body!.cancel();
    await vi.advanceTimersByTimeAsync(99);
    expect((await consume(await handler(request()))).status).toBe(503);
    await vi.advanceTimersByTimeAsync(1);
    expect((await consume(await handler(request("id-1")))).status).toBe(404);
    expect((await consume(await handler(request()))).status).toBe(200);
  });

  it("tracks initialization SSE body cancellation before starting idle expiry", async () => {
    vi.useFakeTimers();
    const handler = await server().createWebStandardHandler({ maxSessions: 1, idleTimeoutMs: 100, sessionIdGenerator: () => "initial-stream" });
    const response = await handler(request());
    expect(response.status).toBe(200);
    await response.body!.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect((await consume(await handler(request("initial-stream")))).status).toBe(404);
  });

  it("parent close clears timers and prevents late initialization from resurrecting sessions", async () => {
    vi.useFakeTimers();
    const instance = server();
    const started = deferred(), resume = deferred();
    let attempts = 0;
    const handler = await instance.createWebStandardHandler({
      idleTimeoutMs: 100, sessionIdGenerator: () => `id-${attempts}`, enableJsonResponse: true,
      configureRequestServer: async () => { if (++attempts === 2) { started.resolve(); await resume.promise; } },
    });
    await consume(await handler(request()));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const late = handler(request()); await started.promise;
    await instance.close();
    expect(vi.getTimerCount()).toBe(0);
    resume.resolve();
    expect((await consume(await late)).status).toBe(503);
    expect((await consume(await handler(request("id-1")))).status).toBe(503);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parent close prevents a late initialization callback from retaining its reserved ID", async () => {
    vi.useFakeTimers();
    const instance = server();
    const started = deferred(), resume = deferred();
    const handler = await instance.createWebStandardHandler({
      idleTimeoutMs: 100, sessionIdGenerator: () => "late-hook", enableJsonResponse: true,
      onsessioninitialized: async () => { started.resolve(); await resume.promise; },
    });
    const pending = handler(request()); await started.promise;
    await instance.close(); resume.resolve();
    expect((await consume(await pending)).status).toBeGreaterThanOrEqual(400);
    expect((await consume(await handler(request("late-hook")))).status).toBe(503);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.1, NaN, Infinity])("rejects invalid capacity and idle timeout %s", async value => {
    const instance = server();
    await expect(instance.createWebStandardHandler({ maxSessions: value })).rejects.toThrow(RangeError);
    await expect(instance.createWebStandardHandler({ idleTimeoutMs: value })).rejects.toThrow(RangeError);
  });
});
