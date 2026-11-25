import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

let gate: (() => Promise<void>) | undefined;

async function setup(options: McpFnWebStandardHandlerOptions<undefined> = {}) {
  const registry = new McpFnRegistry().register({
    name: "echo",
    description: "Echo a value.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    handler: async ({ value }) => {
      await gate?.();
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
    const text = await response.text();
    return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text };
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
    let markEntered!: () => void;
    let open!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const hold = new Promise<void>((resolve) => { open = resolve; });
    const closed: string[] = [];
    const { initialize, call, server } = await setup({
      onsessioninitialized: () => { markEntered(); return hold; },
      onsessionclosed: (id) => { closed.push(id); },
    });
    const pending = initialize();
    await entered;
    await server.close();
    const result = await pending;
    expect(result.status).toBe(503);
    open();
    await vi.waitFor(() => expect(closed).toEqual(["session-1"]));
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

  it("refuses replay after a new session reuses an expired session's public ID", async () => {
    vi.useFakeTimers();
    const streamIds = new Map<string, string>();
    const eventStore = {
      async storeEvent(streamId: string) {
        const id = `event-${streamIds.size + 1}`;
        streamIds.set(id, streamId);
        return id;
      },
      async getStreamIdForEventId(id: string) { return streamIds.get(id); },
      replayEventsAfter: vi.fn(async (id: string) => streamIds.get(id) ?? ""),
    };
    const { handler, initialize } = await setup({
      enableJsonResponse: false, eventStore, sessionIdleTimeoutMs: 100,
      sessionIdGenerator: () => "test-reused-id",
    });
    const first = await initialize(authInfo("alice"));
    const cursor = first.text.match(/^id: (.+)$/m)?.[1];
    expect(cursor).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    const next = await initialize(authInfo("bob"));
    expect(next.sessionId).toBe(first.sessionId);
    const replay = await handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": next.sessionId!, "mcp-protocol-version": "2025-11-25", "last-event-id": cursor! },
    }), { authInfo: authInfo("bob") });
    expect(replay.status).toBe(400);
    expect(eventStore.replayEventsAfter).not.toHaveBeenCalled();
  });

  it("keeps subjectless tokens from different issuers apart", async () => {
    const { initialize, call } = await setup();
    const from = (issuer: string): AuthInfo => ({ token: "test-shared-token-text", clientId: "client-a", scopes: [], extra: { issuer } });
    const { sessionId } = await initialize(from("https://issuer-one.example"));
    expect((await call(sessionId!, from("https://issuer-two.example"))).status).toBe(404);
    expect((await call(sessionId!, from("https://issuer-one.example"))).status).toBe(200);
  });

  it.each([["server shutdown", 503], ["client abort", 499], ["setup timeout", 408]])("interrupts a pending initialize body on %s", async (reason, status) => {
    vi.useFakeTimers();
    const { handler, initialize, server } = await setup({ maxSessions: 1, sessionIdleTimeoutMs: 100 });
    const abort = new AbortController();
    let markRead!: () => void;
    const reading = new Promise<void>((resolve) => { markRead = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => markRead(), cancel }, { highWaterMark: 0 });
    const pending = handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body,
      signal: abort.signal,
      duplex: "half",
    } as RequestInit));
    await reading;
    if (reason === "server shutdown") await server.close();
    else if (reason === "client abort") abort.abort();
    else await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(cancel).toHaveBeenCalledTimes(reason === "client abort" ? 1 : 0);
    expect(body.locked).toBe(false);
    expect(response.status).toBe(status);
    if (status === 408) expect(await response.text()).toContain("Session initialization timed out");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect((await initialize()).status).toBe(200);
  });

  it("uses a host-supplied principal key", async () => {
    const { initialize, call } = await setup({
      sessionPrincipal: ({ request }) => request.headers.get("x-tenant") ?? undefined,
    });
    const { sessionId } = await initialize(undefined, { "x-tenant": "tenant-a" });
    expect((await call(sessionId!)).status).toBe(404);
  });
});

describe("createWebStandardHandler session limits and expiry (MCP-SEC-04)", () => {
  it("refuses excess sessions per principal, with a shared anonymous allowance", async () => {
    const { initialize, call } = await setup({ maxSessionsPerPrincipal: 1 });
    const alice = authInfo("alice");
    const first = await initialize(alice);
    const refused = await initialize(alice);
    expect(refused).toMatchObject({ status: 429, sessionId: null, text: expect.stringContaining("Too many sessions for this principal") });
    expect((await initialize(authInfo("bob"))).status).toBe(200);
    expect((await initialize()).status).toBe(200);
    expect((await initialize()).status).toBe(429);
    expect((await call(first.sessionId!, alice)).status).toBe(200);
  });

  it("reserves capacity for concurrent initialization and frees it on DELETE", async () => {
    let markEntered!: () => void;
    let accept!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    const { handler, initialize, call } = await setup({
      maxSessions: 1,
      onsessioninitialized: async () => { markEntered(); await accepted; },
    });
    const alice = authInfo("alice");
    const pending = initialize(alice);
    await entered;
    const refused = await initialize(authInfo("bob"));
    expect(refused).toMatchObject({ status: 503, sessionId: null, text: expect.stringContaining("Too many sessions for this HTTP handler") });
    accept();
    const first = await pending;
    expect((await call(first.sessionId!, alice)).status).toBe(200);
    const deleted = await handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": first.sessionId!, "mcp-protocol-version": "2025-11-25" },
    }), { authInfo: alice });
    expect(deleted.status).toBe(200);
    expect((await initialize(authInfo("bob"))).status).toBe(200);
  });

  it("releases the slot when the host refuses initialization", async () => {
    const { initialize } = await setup({
      maxSessions: 1,
      onsessioninitialized: (id) => { if (id === "session-1") throw new Error("Test refusal"); },
    });
    expect((await initialize()).status).toBe(400);
    expect((await initialize()).status).toBe(200);
  });

  it("returns a failed SSE setup response while the host cleanup is still pending", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let events = 0;
    const onClosed = vi.fn(() => cleanup);
    const { initialize } = await setup({
      enableJsonResponse: false,
      maxSessions: 1,
      onsessionclosed: onClosed,
      eventStore: {
        async storeEvent() {
          if (++events === 1) throw new Error("Test priming error");
          return `event-${events}`;
        },
        async replayEventsAfter() { return ""; },
      },
    });
    expect((await initialize()).status).toBe(400);
    await vi.advanceTimersByTimeAsync(0);
    expect(onClosed).toHaveBeenCalledExactlyOnceWith("session-1");
    expect((await initialize()).status).toBe(503);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await initialize()).status).toBe(200);
  });

  it.each(["configuration", "acceptance"])("answers 408 while the host %s hook is still pending", async (stage) => {
    vi.useFakeTimers();
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const wait = async () => { markEntered(); await hold; };
    const onClosed = vi.fn();
    const { initialize } = await setup({
      maxSessions: 1,
      sessionIdleTimeoutMs: 100,
      ...(stage === "configuration" ? { configureRequestServer: wait } : { onsessioninitialized: wait }),
      onsessionclosed: onClosed,
    });
    const pending = initialize();
    await entered;
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(408);
    expect((await initialize()).status).toBe(503);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onClosed).toHaveBeenCalledTimes(stage === "acceptance" ? 1 : 0);
    expect((await initialize()).status).toBe(200);
  });

  it("keeps the original setup deadline through host acceptance and SSE priming", async () => {
    vi.useFakeTimers();
    let markAccepted!: () => void;
    let accept!: () => void;
    let startPriming!: () => void;
    let finishPriming!: () => void;
    const accepting = new Promise<void>((resolve) => { markAccepted = resolve; });
    const acceptHook = new Promise<void>((resolve) => { accept = resolve; });
    const priming = new Promise<void>((resolve) => { startPriming = resolve; });
    const primingWrite = new Promise<void>((resolve) => { finishPriming = resolve; });
    let events = 0;
    const { initialize, call } = await setup({
      enableJsonResponse: false,
      maxSessions: 1,
      sessionIdleTimeoutMs: 100,
      onsessioninitialized: () => { markAccepted(); return acceptHook; },
      eventStore: {
        async storeEvent() {
          const id = `event-${++events}`;
          if (events === 1) { startPriming(); await primingWrite; }
          return id;
        },
        async replayEventsAfter() { return ""; },
      },
    });
    const pending = initialize();
    await accepting;
    await vi.advanceTimersByTimeAsync(90);
    accept();
    await priming;
    expect((await call("session-1")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).status).toBe(408);
    expect((await initialize()).status).toBe(503);
    finishPriming();
    await vi.advanceTimersByTimeAsync(0);
    expect((await initialize()).status).toBe(200);
  });

  it("rejects an oversized declared body without reading or canceling the upload", async () => {
    const { handler } = await setup({ maxRequestBodySize: 512 });
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = await handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": "513" },
      body,
      duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("delivers a protocol initialization error and expires its accepted session", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const onClosed = vi.fn();
    const { initialize, call } = await setup({
      enableJsonResponse: false,
      maxSessions: 1,
      sessionIdleTimeoutMs: 100,
      onsessionclosed: onClosed,
      configureRequestServer: (child) => {
        if (++attempts === 1) child.protocol.setRequestHandler(InitializeRequestSchema, () => {
          throw new Error("Test initialization error");
        });
      },
    });
    const failed = await initialize();
    expect(failed.text).toContain('"error":{"code":-32603');
    await vi.advanceTimersByTimeAsync(100);
    expect((await call(failed.sessionId!)).status).toBe(404);
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(failed.sessionId);
    expect((await initialize()).status).toBe(200);
  });

  it("expires and disposes idle sessions without waiting for another request", async () => {
    vi.useFakeTimers();
    const onClosed = vi.fn();
    const protocolClosed = vi.fn();
    const { initialize, call } = await setup({
      maxSessions: 1,
      sessionIdleTimeoutMs: 100,
      onsessionclosed: onClosed,
      configureRequestServer: (child) => { child.protocol.onclose = protocolClosed; },
    });
    const { sessionId } = await initialize();
    await vi.advanceTimersByTimeAsync(99);
    expect((await call(sessionId!)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(99);
    expect(onClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(protocolClosed).toHaveBeenCalledTimes(1);
    expect((await call(sessionId!)).status).toBe(404);
    expect((await initialize()).status).toBe(200);
  });

  it("expires a session while a stand-alone SSE stream is open", async () => {
    vi.useFakeTimers();
    const onClosed = vi.fn();
    const { handler, initialize } = await setup({ sessionIdleTimeoutMs: 100, onsessionclosed: onClosed });
    const { sessionId } = await initialize();
    const stream = await handler(new Request("http://127.0.0.1:8080/mcp", {
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId!, "mcp-protocol-version": "2025-11-25" },
    }));
    expect(stream.status).toBe(200);
    await vi.advanceTimersByTimeAsync(100);
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(await stream.text()).toBe("");
  });

  it("expires and settles a pending JSON request", async () => {
    vi.useFakeTimers();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { initialize, call } = await setup({ sessionIdleTimeoutMs: 100 });
    const { sessionId } = await initialize();
    gate = async () => { enter(); await hold; };
    const pending = call(sessionId!);
    await entered;
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(404);
    release();
  });

  it.each(["idle expiry", "client abort"])("interrupts a named POST upload on %s", async (reason) => {
    vi.useFakeTimers();
    const { handler, initialize, call } = await setup({ sessionIdleTimeoutMs: 100 });
    const { sessionId } = await initialize();
    const abort = new AbortController();
    let markRead!: () => void;
    const reading = new Promise<void>((resolve) => { markRead = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => markRead(), cancel }, { highWaterMark: 0 });
    const pending = handler(new Request("http://127.0.0.1:8080/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-11-25",
      },
      body,
      signal: abort.signal,
      duplex: "half",
    } as RequestInit));
    await reading;
    if (reason === "idle expiry") await vi.advanceTimersByTimeAsync(100);
    else abort.abort();
    expect((await pending).status).toBe(reason === "idle expiry" ? 404 : 499);
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(reason === "idle expiry" ? 0 : 1);
    if (reason === "client abort") expect((await call(sessionId!)).status).toBe(200);
  });

  it("rejects an unlisted SDK Origin at capacity", async () => {
    const { initialize } = await setup({
      maxSessions: 1,
      enableDnsRebindingProtection: true,
      allowedOrigins: ["https://app.example"],
    });
    expect((await initialize()).status).toBe(200);
    expect((await initialize(undefined, { origin: "https://other.example" })).status).toBe(403);
    expect((await initialize(undefined, { origin: "https://app.example" })).status).toBe(503);
  });

  it("does not refresh sessions on rejected SDK Origins", async () => {
    vi.useFakeTimers();
    const { initialize, post, call } = await setup({
      sessionIdleTimeoutMs: 100,
      enableDnsRebindingProtection: true,
      allowedOrigins: ["https://app.example"],
    });
    const { sessionId } = await initialize();
    await vi.advanceTimersByTimeAsync(99);
    const rejected = await post({ jsonrpc: "2.0", id: 2, method: "ping" }, {
      sessionId: sessionId!,
      headers: { origin: "https://other.example" },
    });
    expect(rejected.status).toBe(403);
    await vi.advanceTimersByTimeAsync(1);
    expect((await call(sessionId!)).status).toBe(404);
  });

  it("allows the expiry hook to close the parent server", async () => {
    vi.useFakeTimers();
    const onClosed = vi.fn(async () => { await server.close(); });
    const { initialize, server } = await setup({ maxSessions: 1, sessionIdleTimeoutMs: 100, onsessionclosed: onClosed });
    await initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect((await initialize()).status).toBe(200);
  });

  it("closes the parent transport when a session cleanup hook throws", async () => {
    const dispose = vi.fn();
    const { initialize, server } = await setup({
      onsessionclosed: () => { throw new Error("Test cleanup error"); },
    });
    await server.connect({ start: async () => {}, send: async () => {}, close: async () => { dispose(); } });
    await initialize();
    await server.close();
    expect(dispose).toHaveBeenCalledTimes(1);
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
