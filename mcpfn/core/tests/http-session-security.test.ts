import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnWebStandardHandlerOptions,
} from "../src/index.js";

// Regression tests for the McpFn security audit (MCP-21): MCP-SEC-03 (sessions
// bound to their principal), MCP-SEC-04 (session limits and idle expiry) and
// MCP-SEC-07 (Origin checks against DNS rebinding).

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  gate = undefined;
  vi.useRealTimers();
  await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
});

function authInfo(subject: string, clientId = "client-a"): AuthInfo {
  return { token: "test-access-token", clientId, scopes: [], extra: { subject } };
}

let gate: Promise<void> | undefined;

async function setup(options: McpFnWebStandardHandlerOptions<undefined> = {}) {
  const registry = new McpFnRegistry().register({
    name: "echo",
    description: "Echo a value.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    handler: async ({ value }) => {
      await gate;
      return structuredResult({ value });
    },
  });
  const server = createMcpFnServer({ info: { name: "session-security", version: "1.0.0" }, registry });
  closeables.push(server);
  let next = 0;
  const closed: string[] = [];
  const handler = await server.createWebStandardHandler({
    enableJsonResponse: true,
    sessionIdGenerator: () => `session-${++next}`,
    ...options,
  });
  const post = (body: unknown, init: { sessionId?: string; auth?: AuthInfo; headers?: Record<string, string> } = {}) =>
    handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(init.sessionId ? { "mcp-session-id": init.sessionId, "mcp-protocol-version": "2025-11-25" } : {}),
        ...init.headers,
      },
      body: JSON.stringify(body),
    }), init.auth ? { authInfo: init.auth } : undefined);
  const initialize = async (auth?: AuthInfo, headers?: Record<string, string>) => {
    const response = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client", version: "1.0.0" } },
    }, { auth, headers });
    await response.text();
    return { status: response.status, sessionId: response.headers.get("mcp-session-id") };
  };
  const call = async (sessionId: string, auth?: AuthInfo) => {
    const response = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { value: "hi" } } },
      { sessionId, auth },
    );
    const text = await response.text();
    return { status: response.status, text };
  };
  return { handler, post, initialize, call, closed };
}

describe("createWebStandardHandler session binding (MCP-SEC-03)", () => {
  it("answers 404 when another principal uses a session ID", async () => {
    const { initialize, call } = await setup();
    const { sessionId } = await initialize(authInfo("alice"));
    expect(sessionId).toBe("session-1");
    expect((await call(sessionId!, authInfo("mallory"))).status).toBe(404);
    expect((await call(sessionId!, authInfo("alice", "client-b"))).status).toBe(404);
    expect((await call(sessionId!)).status).toBe(404);
    const owner = await call(sessionId!, authInfo("alice"));
    expect(owner.status).toBe(200);
    expect(owner.text).toContain("hi");
  });

  it("refuses DELETE of a session by another principal", async () => {
    const { handler, initialize, call } = await setup();
    const { sessionId } = await initialize(authInfo("alice"));
    const remove = (auth: AuthInfo) => handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId!, "mcp-protocol-version": "2025-11-25" },
    }), { authInfo: auth });
    expect((await remove(authInfo("mallory"))).status).toBe(404);
    expect((await call(sessionId!, authInfo("alice"))).status).toBe(200);
    expect((await remove(authInfo("alice"))).status).toBe(200);
    expect((await call(sessionId!, authInfo("alice"))).status).toBe(404);
  });

  it("refuses an authenticated request on an unauthenticated session", async () => {
    const { initialize, call } = await setup();
    const { sessionId } = await initialize();
    expect((await call(sessionId!, authInfo("alice"))).status).toBe(404);
    expect((await call(sessionId!)).status).toBe(200);
  });

  it("uses a host-supplied principal key", async () => {
    const { initialize, call } = await setup({
      sessionPrincipal: ({ request }) => request.headers.get("x-tenant") ?? undefined,
    });
    const { sessionId } = await initialize(undefined, { "x-tenant": "tenant-a" });
    expect((await call(sessionId!)).status).toBe(404);
  });
});

describe("createWebStandardHandler session limits (MCP-SEC-04)", () => {
  it("keeps at most maxSessions, closing the least recently used", async () => {
    const { initialize, call } = await setup({ maxSessions: 2 });
    const first = await initialize();
    const second = await initialize();
    expect((await call(first.sessionId!)).status).toBe(200);
    const third = await initialize();
    expect(third.status).toBe(200);
    expect((await call(second.sessionId!)).status).toBe(404);
    expect((await call(first.sessionId!)).status).toBe(200);
    expect((await call(third.sessionId!)).status).toBe(200);
  });

  it("does not grow without bound under repeated initialize", async () => {
    const { initialize, call } = await setup({ maxSessions: 3 });
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) ids.push((await initialize()).sessionId!);
    const alive = [];
    for (const id of ids) if ((await call(id)).status === 200) alive.push(id);
    expect(alive).toEqual(ids.slice(-3));
  });

  it("caps sessions per principal without touching other principals", async () => {
    const { initialize, call } = await setup({ maxSessionsPerPrincipal: 2 });
    const bob = await initialize(authInfo("bob"));
    const alice = [
      await initialize(authInfo("alice")),
      await initialize(authInfo("alice")),
      await initialize(authInfo("alice")),
    ];
    expect((await call(alice[0]!.sessionId!, authInfo("alice"))).status).toBe(404);
    expect((await call(alice[1]!.sessionId!, authInfo("alice"))).status).toBe(200);
    expect((await call(alice[2]!.sessionId!, authInfo("alice"))).status).toBe(200);
    expect((await call(bob.sessionId!, authInfo("bob"))).status).toBe(200);
  });

  it("closes sessions idle longer than sessionIdleTimeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { initialize, call } = await setup({ sessionIdleTimeoutMs: 60_000 });
    const idle = await initialize();
    const busy = await initialize();
    vi.advanceTimersByTime(45_000);
    expect((await call(busy.sessionId!)).status).toBe(200);
    vi.advanceTimersByTime(30_000);
    expect((await call(idle.sessionId!)).status).toBe(404);
    expect((await call(busy.sessionId!)).status).toBe(200);
  });

  it("does not exceed the per-principal limit under concurrent initialization", async () => {
    const { initialize } = await setup({ maxSessionsPerPrincipal: 1 });
    const results = await Promise.all([initialize(authInfo("alice")), initialize(authInfo("alice"))]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 429]);
  });

  it("does not exceed maxSessions under concurrent initialization", async () => {
    const { initialize } = await setup({ maxSessions: 1 });
    const results = await Promise.all([initialize(), initialize(authInfo("bob"))]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 503]);
  });

  it("never evicts a session with a request in progress", async () => {
    const { initialize, call } = await setup({ maxSessions: 1 });
    const busy = await initialize();
    let open!: () => void;
    gate = new Promise((resolve) => { open = resolve; });
    const pending = call(busy.sessionId!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await initialize()).status).toBe(503);
    open();
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(answered.text).toContain("hi");
  });

  it("does not evict sessions for requests that never initialize", async () => {
    const { handler, post, initialize, call } = await setup({ maxSessions: 1 });
    const kept = await initialize();
    expect((await handler(new Request("http://127.0.0.1:8080/mcp", { method: "PUT" }))).status).toBe(405);
    expect((await post({ jsonrpc: "2.0", id: 9, method: "tools/list" })).status).toBe(400);
    expect((await call(kept.sessionId!)).status).toBe(200);
  });

  it("keeps a host principal key apart from anonymous sessions", async () => {
    const { initialize, post } = await setup({
      maxSessionsPerPrincipal: 1,
      // A key spelled like an internal anonymous marker.
      sessionPrincipal: ({ request }) => request.headers.has("x-principal") ? "\u0000anonymous" : undefined,
    });
    const headers = { "x-principal": "yes" };
    const named = await initialize(undefined, headers);
    expect((await initialize()).status).toBe(200);
    const response = await post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { value: "hi" } } },
      { sessionId: named.sessionId!, headers },
    );
    expect(response.status).toBe(200);
  });

  it("does not keep a session whose onsessioninitialized hook failed", async () => {
    let fail = true;
    const { initialize, call } = await setup({
      maxSessions: 1,
      onsessioninitialized: () => {
        if (fail) throw new Error("host refused");
      },
    });
    const refused = await initialize();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    fail = false;
    const accepted = await initialize();
    expect(accepted.status).toBe(200);
    expect((await call(accepted.sessionId!)).status).toBe(200);
  });

  it("does not evict a session to make room for an initialization the host rejects", async () => {
    let fail = false;
    const { initialize, call } = await setup({
      maxSessions: 1,
      onsessioninitialized: () => {
        if (fail) throw new Error("host refused");
      },
    });
    const kept = await initialize();
    fail = true;
    expect((await initialize()).status).toBeGreaterThanOrEqual(400);
    expect((await call(kept.sessionId!)).status).toBe(200);
  });

  it("lets sessions without a principal share one per-principal allowance", async () => {
    const { initialize, call } = await setup({ maxSessionsPerPrincipal: 2 });
    const first = await initialize();
    await initialize();
    await initialize();
    expect((await call(first.sessionId!)).status).toBe(404);
  });

  it("runs onsessionclosed for expired and evicted sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const closed: string[] = [];
    const { initialize } = await setup({
      maxSessions: 2,
      sessionIdleTimeoutMs: 60_000,
      onsessionclosed: (id) => { closed.push(id); },
    });
    const first = await initialize();
    await initialize();
    const third = await initialize();
    expect(closed).toEqual([first.sessionId]);
    vi.advanceTimersByTime(61_000);
    await initialize();
    expect(closed).toContain(third.sessionId);
    expect(closed).toHaveLength(3);
  });

  it.each([
    ["maxSessions", 0],
    ["maxSessions", 1.5],
    ["maxSessionsPerPrincipal", -1],
    ["sessionIdleTimeoutMs", 0],
    ["sessionIdleTimeoutMs", Number.NaN],
  ])("rejects %s = %s", async (name, value) => {
    await expect(setup({ [name]: value })).rejects.toThrow(name);
  });
});

describe("createWebStandardHandler Origin policy (MCP-SEC-07)", () => {
  it("refuses a DNS-rebinding page whose Origin matches its rebound Host", async () => {
    const { handler } = await setup();
    const response = await handler(new Request("http://attacker.example:8080/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "attacker.example:8080",
        origin: "http://attacker.example:8080",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } }),
    }));
    expect(response.status).toBe(403);
  });

  it("accepts clients without Origin, listed origins and same-origin loopback pages", async () => {
    const { initialize } = await setup({ allowedOrigins: ["https://app.example"] });
    expect((await initialize()).status).toBe(200);
    expect((await initialize(undefined, { origin: "https://app.example" })).status).toBe(200);
    expect((await initialize(undefined, { origin: "http://127.0.0.1:8080" })).status).toBe(200);
    expect((await initialize(undefined, { origin: "http://127.0.0.1:9999" })).status).toBe(403);
    expect((await initialize(undefined, { origin: "https://other.example" })).status).toBe(403);
    expect((await initialize(undefined, { origin: "null" })).status).toBe(403);
  });

  it("applies to stateless handlers too", async () => {
    const registry = new McpFnRegistry();
    const server = createMcpFnServer({ info: { name: "stateless", version: "1.0.0" }, registry });
    closeables.push(server);
    const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
    const response = await handler(new Request("http://localhost:8080/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
  });

  it("can be turned off, or left to the SDK's own checks", async () => {
    const off = await setup({ originPolicy: "off" });
    expect((await off.initialize(undefined, { origin: "https://other.example" })).status).toBe(200);
    const sdk = await setup({ enableDnsRebindingProtection: true, allowedHosts: ["127.0.0.1:8080"] });
    expect((await sdk.initialize(undefined, { host: "127.0.0.1:8080", origin: "https://other.example" })).status).toBe(200);
    expect((await sdk.initialize(undefined, { host: "attacker.example:8080" })).status).toBe(403);
  });
});
