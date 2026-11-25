import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSearchFnServer, type SearchFnAction, type SearchFnServerConfig, type ServerContext } from "../src";

function testAdapter() {
  return {
    name: "test",
    index: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    searchAll: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

function post(path: string, body: unknown, contentType = "application/json") {
  return new Request(`https://test.example/searchfn/${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("SearchFn authorization", () => {
  it("requires an authorization policy or explicit unauthenticated mode", async () => {
    const adapter = testAdapter();
    await expect(createSearchFnServer({ adapter })).rejects.toThrow("requires authorize");

    const server = await createSearchFnServer({ adapter, allowUnauthenticated: true });
    const response = await server.router.handle(post("search-all", { query: "sample" }));
    expect(response.status).toBe(200);
    expect(adapter.searchAll).toHaveBeenCalledOnce();
  });

  it.each([
    ["status", "status", null, []],
    ["index", "index", { resource: "docs", documents: [{ id: "doc-1", fields: { title: "sample" } }] }, ["docs"]],
    ["search", "search", { resource: "docs", query: "sample" }, ["docs"]],
    ["search-all", "searchAll", { resources: ["docs", "notes"], query: "sample" }, ["docs", "notes"]],
    ["remove", "remove", { resource: "docs", ids: ["doc-1"] }, ["docs"]],
    ["clear", "clear", { resource: "docs" }, ["docs"]],
  ] satisfies [string, SearchFnAction, unknown, string[]][])(
    "passes the request, identity and effective targets to the policy for %s",
    async (path, action, payload, resources) => {
      const adapter = testAdapter();
      const authorize = vi.fn((ctx: { principal: string | null }) => ctx.principal === "test-reader");
      const server = await createSearchFnServer({
        adapter,
        context: (request) => ({ principal: request.headers.get("x-test-principal") }),
        authorize,
      });
      const request = action === "status"
        ? new Request("https://test.example/searchfn/status")
        : post(path, payload, "Application/JSON; charset=utf-8");
      request.headers.set("x-test-principal", "test-reader");

      expect((await server.router.handle(request)).status).toBe(200);
      expect(authorize).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ principal: "test-reader" }), action, payload, request, resources,
      );
    },
  );

  it.each(["deny", "throw"])("keeps the adapter untouched when the policy says %s", async (decision) => {
    const adapter = testAdapter();
    const server = await createSearchFnServer({
      adapter,
      allowUnauthenticated: true,
      authorize: () => {
        if (decision === "throw") throw new Error("policy failure");
        return false;
      },
    });

    const response = await server.router.handle(post("clear", { resource: "docs" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false, error: { code: "FORBIDDEN", message: "Authorization denied" },
    });
    expect(adapter.clear).not.toHaveBeenCalled();
  });

  it("denies a failed identity lookup and records a sanitized authorization event", async () => {
    const adapter = testAdapter();
    const authorize = vi.fn(() => true);
    const events = vi.fn();
    const error = vi.fn();
    const server = await createSearchFnServer({
      adapter,
      authorize,
      context: async () => { throw new Error("test-credential"); },
      observability: { events, logger: { error } },
    });

    const response = await server.router.handle(post("clear", { resource: "docs" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false, error: { code: "FORBIDDEN", message: "Authorization denied" },
    });
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "searchfn.authorization.failed" }));
    expect(error).toHaveBeenCalledWith("authorization.error", expect.objectContaining({ operation: "clear" }));
    expect(JSON.stringify([events.mock.calls, error.mock.calls])).not.toContain("test-credential");
    expect(authorize).not.toHaveBeenCalled();
    expect(adapter.clear).not.toHaveBeenCalled();
  });

  it("passes custom context to the policy intact", async () => {
    class AuthorizationContext {
      #authorized = true;
      params = { scope: "docs" };

      canClearDocs() {
        return this.#authorized && this.params.scope === "docs";
      }
    }

    const adapter = testAdapter();
    const identity = new AuthorizationContext();
    const server = await createSearchFnServer({
      adapter,
      context: () => identity,
      authorize: (ctx) => ctx === identity && ctx.canClearDocs(),
    });
    const middlewareContext = vi.fn();
    server.router.use(async (_request, ctx, next) => {
      expectTypeOf(ctx).toMatchTypeOf<ServerContext>();
      expectTypeOf(ctx.canClearDocs).toEqualTypeOf<unknown>();
      middlewareContext(ctx);
      return next();
    });

    expect((await server.router.handle(post("clear", { resource: "docs" }))).status).toBe(200);
    expect(middlewareContext).toHaveBeenCalledWith(expect.objectContaining({ params: {} }));
    expect(middlewareContext.mock.calls[0][0].canClearDocs).toBeUndefined();
  });

  it("accepts a declared policy context that can be null", async () => {
    interface Identity { userId: string }
    const config: SearchFnServerConfig<Identity | null> = {
      adapter: testAdapter(),
      context: () => null,
      authorize: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<Identity | null>();
        return ctx?.userId === "test-user";
      },
    };
    const server = await createSearchFnServer(config);
    expect((await server.router.handle(post("clear", { resource: "docs" }))).status).toBe(403);
  });

  it("types the policy with the resolved context of an async factory", async () => {
    const identity = { userId: "test-user" };
    const context = async () => identity;
    const config: SearchFnServerConfig<ReturnType<typeof context>> = {
      adapter: testAdapter(),
      context,
      authorize: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<typeof identity>();
        return ctx === identity;
      },
    };
    const server = await createSearchFnServer(config);
    expect((await server.router.handle(post("clear", { resource: "docs" }))).status).toBe(200);
  });

  it("accepts factory-free policies typed with standard router fields", async () => {
    const server = await createSearchFnServer({
      adapter: testAdapter(),
      authorize: (ctx: { query: URLSearchParams }) => ctx.query.get("health") === "ready",
    });
    const response = await server.router.handle(new Request("https://test.example/searchfn/status?health=ready"));
    expect(response.status).toBe(200);
  });

  it.each([{ resources: undefined }, { resources: null }, { resources: [] }])(
    "requires explicit authorized search-all targets ($resources)",
    async ({ resources }) => {
      const adapter = testAdapter();
      const authorize = vi.fn(() => true);
      const server = await createSearchFnServer({ adapter, authorize });

      const response = await server.router.handle(post("search-all", { query: "sample", resources }));
      expect(response.status).toBe(400);
      expect(authorize).not.toHaveBeenCalled();
      expect(adapter.searchAll).not.toHaveBeenCalled();
    },
  );

  it.each(["index", "search", "remove", "clear", "search-all"])("rejects ambiguous scope fields on %s", async (path) => {
    const adapter = testAdapter();
    const authorize = vi.fn(() => true);
    const server = await createSearchFnServer({ adapter, authorize });

    const response = await server.router.handle(post(path, { resource: "docs", resources: ["docs"] }));
    expect(response.status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "application/json; charset=utf-8, text/plain"])("rejects unsupported Content-Type %s", async (contentType) => {
    const adapter = testAdapter();
    const authorize = vi.fn(() => true);
    const info = vi.fn();
    const server = await createSearchFnServer({ adapter, authorize, observability: { logger: { info } } });

    const response = await server.router.handle(post("clear", { resource: "docs" }, contentType));
    expect(response.status).toBe(415);
    expect(info).toHaveBeenCalledWith("request.end", expect.objectContaining({ status: 415, success: false }));
    expect(authorize).not.toHaveBeenCalled();
    expect(adapter.clear).not.toHaveBeenCalled();
  });

  it.each(['Application/JSON; note="a,b"', "application/json;", "application/json; ; charset=utf-8;"])("accepts valid JSON Content-Type %s", async (contentType) => {
    const adapter = testAdapter();
    const server = await createSearchFnServer({ adapter, authorize: () => true });
    const response = await server.router.handle(post("clear", { resource: "docs" }, contentType));
    expect(response.status).toBe(200);
  });

  it("passes deeply nested JSON fields to the policy within the payload limit", async () => {
    const adapter = testAdapter();
    const authorize = vi.fn(() => true);
    const server = await createSearchFnServer({ adapter, authorize });
    const depth = 12_000;
    const request = new Request("https://test.example/searchfn/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"resource":"docs","details":${"[".repeat(depth)}null${"]".repeat(depth)}}`,
    });

    expect((await server.router.handle(request)).status).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    expect(adapter.clear).toHaveBeenCalledOnce();
  });

  it("keeps the validated adapter input independent of policy edits", async () => {
    const adapter = testAdapter();
    const server = await createSearchFnServer({
      adapter,
      authorize: (_ctx, _action, payload) => {
        (payload as { resources: string[] }).resources.push("notes");
        return true;
      },
    });

    expect((await server.router.handle(post("search-all", { query: "sample", resources: ["docs"] }))).status).toBe(200);
    expect(adapter.searchAll).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resources: ["docs"] }));
  });
});
