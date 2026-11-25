import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnWebStandardHandlerOptions,
} from "../src/index.js";

// Regression tests for the McpFn security audit (MCP-21): MCP-SEC-03 (sessions
// bound to their principal) and MCP-SEC-07 (Origin checks against DNS rebinding).

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
  return { handler, post, initialize, call, closed, server };
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

  it("tells apart subjectless users of one OAuth client by their token", async () => {
    const { initialize, call } = await setup();
    const tokenOf = (token: string): AuthInfo => ({ token, clientId: "shared-public-client", scopes: [] });
    const { sessionId } = await initialize(tokenOf("test-token-alice"));
    expect((await call(sessionId!, tokenOf("test-token-bob"))).status).toBe(404);
    expect((await call(sessionId!, tokenOf("test-token-alice"))).status).toBe(200);
  });

  it("does not create a session for an initialization that started before close()", async () => {
    let open!: () => void;
    const hold = new Promise<void>((resolve) => { open = resolve; });
    const { initialize, server } = await setup({ sessionPrincipal: async () => { await hold; return undefined; } });
    const pending = initialize();
    await server.close();
    open();
    expect((await pending).status).toBe(503);
  });

  it("does not create a session when close() runs while the host accepts it", async () => {
    let open!: () => void;
    const hold = new Promise<void>((resolve) => { open = resolve; });
    const closed: string[] = [];
    const { initialize, call, server } = await setup({
      onsessioninitialized: () => hold,
      onsessionclosed: (id) => { closed.push(id); },
    });
    const pending = initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await server.close();
    open();
    const result = await pending;
    expect(result.status).not.toBe(200);
    expect(closed).toEqual(["session-1"]);
    expect((await call("session-1")).status).not.toBe(200);
  });

  it("calls onsessioninitialized as a method of the options", async () => {
    const options = {
      label: "kept",
      seen: [] as string[],
      onsessioninitialized(this: { label: string; seen: string[] }) { this.seen.push(this.label); },
    };
    const { initialize } = await setup(options as never);
    expect((await initialize()).status).toBe(200);
    expect(options.seen).toEqual(["kept"]);
  });

  it("uses a host-supplied principal key", async () => {
    const { initialize, call } = await setup({
      sessionPrincipal: ({ request }) => request.headers.get("x-tenant") ?? undefined,
    });
    const { sessionId } = await initialize(undefined, { "x-tenant": "tenant-a" });
    expect((await call(sessionId!)).status).toBe(404);
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

  it("compares loopback origins with default ports normalised", async () => {
    const registry = new McpFnRegistry();
    const server = createMcpFnServer({ info: { name: "stateless", version: "1.0.0" }, registry });
    closeables.push(server);
    const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
    const send = (url: string, host: string, origin: string) => handler(new Request(url, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", host, origin },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
    expect((await send("https://localhost/mcp", "localhost:443", "https://localhost")).status).not.toBe(403);
    expect((await send("https://localhost/mcp", "localhost", "http://localhost")).status).toBe(403);
    expect((await send("https://localhost/mcp", "localhost:000443", "https://localhost")).status).not.toBe(403);
    expect((await send("https://localhost/mcp", "localhost/path", "https://localhost")).status).toBe(403);
    expect((await send("https://localhost/mcp", "user@localhost", "https://localhost")).status).toBe(403);
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
