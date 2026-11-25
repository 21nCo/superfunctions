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
    expect(result.status).toBe(503);
    expect(closed).toEqual(["session-1"]);
    expect((await call("session-1")).status).not.toBe(200);
  });

  it("calls onsessioninitialized as a method of the options", async () => {
    class HostOptions {
      enableJsonResponse = true;
      sessionIdGenerator = () => "session-x";
      receivers: unknown[] = [];
      onsessioninitialized() { this.receivers.push(this); }
    }
    const options = new HostOptions();
    const registry = new McpFnRegistry();
    const server = createMcpFnServer({ info: { name: "receiver", version: "1.0.0" }, registry });
    closeables.push(server);
    const handler = await server.createWebStandardHandler(options as never);
    const response = await handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } }),
    }));
    await response.text();
    expect(response.status).toBe(200);
    expect(options.receivers).toEqual([options]);
    expect(options.receivers[0]).toBe(options);
  });

  it("still runs onsessionclosed for a stateless DELETE", async () => {
    const closed: unknown[] = [];
    const server = createMcpFnServer({ info: { name: "stateless", version: "1.0.0" }, registry: new McpFnRegistry() });
    closeables.push(server);
    const options = { enableJsonResponse: true, onsessionclosed(this: unknown, id: string) { closed.push([this, id]); } };
    const handler = await server.createWebStandardHandler(options as never);
    await handler(new Request("http://127.0.0.1:8080/mcp", { method: "DELETE", headers: { "mcp-protocol-version": "2025-11-25" } }));
    expect(closed).toHaveLength(1);
    expect((closed[0] as unknown[])[0]).toBe(options);
  });

  it("keeps principals from different issuers apart", async () => {
    const { initialize, call } = await setup();
    const from = (issuer: string): AuthInfo => ({ token: "test-access-token", clientId: "client-a", scopes: [], extra: { subject: "alice", issuer } });
    const { sessionId } = await initialize(from("https://issuer-one.example"));
    expect((await call(sessionId!, from("https://issuer-two.example"))).status).toBe(404);
    expect((await call(sessionId!, from("https://issuer-one.example"))).status).toBe(200);
  });

  it("keeps one actor's sessions in different tenants apart", async () => {
    const { initialize, call } = await setup();
    // The AuthFn provider adapter's shape: the same actor and default client
    // ID in both tenants, told apart only by extra.tenantId.
    const from = (tenantId: string): AuthInfo => ({
      token: "test-access-token",
      clientId: "user:alice",
      scopes: [],
      extra: { subject: "alice", tenantId },
    });
    const { sessionId } = await initialize(from("tenant-a"));
    expect((await call(sessionId!, from("tenant-b"))).status).toBe(404);
    expect((await call(sessionId!, from("tenant-a"))).status).toBe(200);
  });

  it("does not replay another session's events from a shared event store", async () => {
    const events = new Map<string, { streamId: string; message: unknown }>();
    let next = 0;
    const eventStore = {
      async storeEvent(streamId: string, message: unknown) {
        const id = `event-${++next}`;
        events.set(id, { streamId, message });
        return id;
      },
      async replayEventsAfter(lastEventId: string, { send }: { send: (id: string, message: unknown) => Promise<void> }) {
        const origin = events.get(lastEventId);
        if (!origin) throw new Error("unknown event");
        let after = false;
        for (const [id, event] of events) {
          if (id === lastEventId) { after = true; continue; }
          if (after && event.streamId === origin.streamId) await send(id, event.message);
        }
        return origin.streamId;
      },
    };
    const { initialize, post, handler } = await setup({ enableJsonResponse: false, eventStore } as never);
    const alice = await initialize(authInfo("alice"));
    const bob = await initialize(authInfo("bob"));
    const secret = await post(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: { value: "alice-private" } } },
      { sessionId: alice.sessionId!, auth: authInfo("alice") },
    );
    expect(await secret.text()).toContain("alice-private");
    const aliceEvents = [...events.keys()];
    for (const lastEventId of aliceEvents) {
      const replay = await handler(new Request("http://127.0.0.1:8080/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-session-id": bob.sessionId!, "mcp-protocol-version": "2025-11-25", "last-event-id": lastEventId },
      }), { authInfo: authInfo("bob") });
      // Read what the (possibly open) SSE stream delivers within a short window.
      let text = "";
      const reader = replay.body?.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 100;
      while (reader && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), deadline - Date.now())),
        ]);
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader?.cancel().catch(() => undefined);
      expect(text).not.toContain("alice-private");
    }
  });

  it("keeps event IDs header-safe and replays the owner's missed events on resume", async () => {
    // Deterministic ordering, with event IDs shaped like the SDK example
    // store's (the stream ID, an underscore, then a sequence).
    const events: Array<{ id: string; streamId: string; message: unknown }> = [];
    const eventStore = {
      async storeEvent(streamId: string, message: unknown) {
        const id = `${streamId}_${String(events.length + 1).padStart(6, "0")}`;
        events.push({ id, streamId, message });
        return id;
      },
      async getStreamIdForEventId(eventId: string) {
        return events.find((event) => event.id === eventId)?.streamId;
      },
      async replayEventsAfter(lastEventId: string, { send }: { send: (id: string, message: unknown) => Promise<void> }) {
        const index = events.findIndex((event) => event.id === lastEventId);
        if (index < 0) return "";
        const { streamId } = events[index]!;
        for (const event of events.slice(index + 1)) {
          if (event.streamId === streamId) await send(event.id, event.message);
        }
        return streamId;
      },
    };
    const { post, handler, initialize } = await setup({ enableJsonResponse: false, eventStore } as never);
    const alice = await initialize(authInfo("alice"));
    const call = await post(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: { value: "resumed-result" } } },
      { sessionId: alice.sessionId!, auth: authInfo("alice") },
    );
    const ids = [...(await call.text()).matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
    // A priming event precedes the result, so resuming after it replays the result.
    expect(ids.length).toBeGreaterThan(1);
    const resumed = await handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": alice.sessionId!, "mcp-protocol-version": "2025-11-25", "last-event-id": ids[0]! },
    }), { authInfo: authInfo("alice") });
    expect(resumed.status).toBe(200);
    let text = "";
    const reader = resumed.body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 1_000;
    while (!text.includes("resumed-result") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), deadline - Date.now())),
      ]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    expect(text).toContain("resumed-result");
    expect(text).toContain(`id: ${ids[1]}`);
  });

  it("answers an unknown Last-Event-ID with an empty resumed stream", async () => {
    const { InMemoryEventStore } = await import("@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js");
    const { handler, initialize } = await setup({ enableJsonResponse: false, eventStore: new InMemoryEventStore() } as never);
    const alice = await initialize(authInfo("alice"));
    const resumed = await handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": alice.sessionId!, "mcp-protocol-version": "2025-11-25", "last-event-id": "evicted-event" },
    }), { authInfo: authInfo("alice") });
    expect(resumed.status).toBe(200);
    await resumed.body?.cancel();
  });

  it("keeps subjectless tokens from different issuers apart", async () => {
    const { initialize, call } = await setup();
    const from = (issuer: string): AuthInfo => ({ token: "test-shared-token-text", clientId: "client-a", scopes: [], extra: { issuer } });
    const { sessionId } = await initialize(from("https://issuer-one.example"));
    expect((await call(sessionId!, from("https://issuer-two.example"))).status).toBe(404);
    expect((await call(sessionId!, from("https://issuer-one.example"))).status).toBe(200);
  });

  it("answers 503 when close() runs while the initialize body is still being read", async () => {
    const { handler, server } = await setup();
    let push!: (chunk: Uint8Array) => void;
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        finish = () => controller.close();
      },
    });
    const pending = handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await server.close();
    push(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } })));
    finish();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("mcp-session-id")).toBeNull();
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
