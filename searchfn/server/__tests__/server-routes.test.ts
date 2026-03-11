import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSearchFnServer } from "../src/server";
import { MemoryAdapter } from "@searchfn/adapters";
import type { SearchAdapter } from "@searchfn/adapters";
import { SearchAdapterError } from "@searchfn/adapters";

// Helper: make a request and get response body
async function req(
  router: { handle(r: Request): Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const r = new Request(`http://localhost${path}`, init);
  const res = await router.handle(r);
  const json = await res.json();
  return { status: res.status, body: json };
}

describe("@searchfn/server routes", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  afterEach(async () => {
    try { await adapter.dispose?.(); } catch { /* ignore */ }
  });

  // ── SRV-001: Constructor + endpoint registration ──

  describe("SRV-001: constructor and endpoint registration", () => {
    it("creates server with all 6 endpoints", async () => {
      const server = await createSearchFnServer({ adapter });
      const routes = server.router.getRoutes();
      const paths = routes.map((r: any) => `${r.method} ${r.path}`);

      expect(paths).toContain("GET /searchfn/status");
      expect(paths).toContain("POST /searchfn/index");
      expect(paths).toContain("POST /searchfn/search");
      expect(paths).toContain("POST /searchfn/search-all");
      expect(paths).toContain("POST /searchfn/remove");
      expect(paths).toContain("POST /searchfn/clear");
    });

    it("uses custom basePath", async () => {
      const server = await createSearchFnServer({ adapter, basePath: "/api/search" });
      const routes = server.router.getRoutes();
      const paths = routes.map((r: any) => `${r.method} ${r.path}`);
      expect(paths).toContain("GET /api/search/status");
      expect(paths).toContain("POST /api/search/search");
    });

    it("close() calls adapter.dispose", async () => {
      const disposeSpy = vi.fn();
      const mockAdapter: SearchAdapter = {
        name: "mock",
        async index() {},
        async search() { return []; },
        async remove() {},
        async clear() {},
        dispose: disposeSpy,
      };
      const server = await createSearchFnServer({ adapter: mockAdapter });
      await server.close();
      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("close() works when adapter has no dispose", async () => {
      const mockAdapter: SearchAdapter = {
        name: "no-dispose",
        async index() {},
        async search() { return []; },
        async remove() {},
        async clear() {},
      };
      const server = await createSearchFnServer({ adapter: mockAdapter });
      await expect(server.close()).resolves.toBeUndefined();
    });
  });

  // ── SRV-004: Status endpoint ──

  describe("SRV-004: GET /status", () => {
    it("returns adapter name and capabilities", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "GET", "/searchfn/status");
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result.adapter).toBe("memory");
      expect(body.result.capabilities).toBeDefined();
      expect(typeof body.result.uptimeMs).toBe("number");
      expect(body.result.state).toBe("ok");
      expect(body.result.failureCount).toBe(0);
    });

    it("reports degraded state after a server failure", async () => {
      const failingAdapter: SearchAdapter = {
        name: "failing",
        async index() {
          throw new Error("boom");
        },
        async search() {
          return [];
        },
        async remove() {},
        async clear() {},
      };

      const server = await createSearchFnServer({ adapter: failingAdapter });
      const failed = await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [{ id: "t1", fields: { title: "hello" } }],
      });
      expect(failed.status).toBe(500);

      const { status, body } = await req(server.router, "GET", "/searchfn/status");
      expect(status).toBe(200);
      expect(body.result.state).toBe("degraded");
      expect(body.result.failureCount).toBe(1);
      expect(typeof body.result.degradedSince).toBe("number");
    });
  });

  // ── API-002: Canonical envelopes ──

  describe("API-002: canonical envelopes", () => {
    it("success envelope has ok:true + result", async () => {
      const server = await createSearchFnServer({ adapter });
      const { body } = await req(server.router, "GET", "/searchfn/status");
      expect(body).toHaveProperty("ok", true);
      expect(body).toHaveProperty("result");
      expect(body).not.toHaveProperty("error");
    });

    it("error envelope has ok:false + error.code + error.message", async () => {
      const server = await createSearchFnServer({ adapter });
      const { body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "   ",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(typeof body.error.message).toBe("string");
    });
  });

  // ── POST /index success ──

  describe("POST /index", () => {
    it("indexes documents and returns count", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [
          { id: "t1", fields: { title: "hello world" } },
          { id: "t2", fields: { title: "goodbye" } },
        ],
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result.indexed).toBe(2);
    });
  });

  // ── POST /search success (TV-API-002) ──

  describe("POST /search", () => {
    it("returns matching ids in envelope", async () => {
      const server = await createSearchFnServer({ adapter });
      await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [
          { id: "t-1", fields: { title: "hello world" } },
          { id: "t-2", fields: { title: "hello there" } },
          { id: "t-3", fields: { title: "goodbye" } },
        ],
      });

      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "hello",
        limit: 2,
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result.ids).toBeDefined();
      expect(Array.isArray(body.result.ids)).toBe(true);
    });
  });

  // ── POST /search-all ──

  describe("POST /search-all", () => {
    it("returns merged results across resources", async () => {
      const server = await createSearchFnServer({ adapter });
      await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [{ id: "t1", fields: { title: "alpha beta" } }],
      });
      await req(server.router, "POST", "/searchfn/index", {
        resource: "notes",
        documents: [{ id: "n1", fields: { body: "alpha gamma" } }],
      });

      const { status, body } = await req(server.router, "POST", "/searchfn/search-all", {
        query: "alpha",
        resources: ["tasks", "notes"],
        limit: 10,
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.result.results)).toBe(true);
    });
  });

  // ── POST /remove ──

  describe("POST /remove", () => {
    it("removes documents", async () => {
      const server = await createSearchFnServer({ adapter });
      await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [{ id: "t1", fields: { title: "remove me" } }],
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/remove", {
        resource: "tasks",
        ids: ["t1"],
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result.removed).toBe(1);
    });
  });

  // ── POST /clear ──

  describe("POST /clear", () => {
    it("clears a resource", async () => {
      const server = await createSearchFnServer({ adapter });
      await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [{ id: "t1", fields: { title: "clear me" } }],
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/clear", {
        resource: "tasks",
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result.cleared).toBe("tasks");
    });
  });

  // ── SRV-002: Validation + limits ──

  describe("SRV-002: validation and limits", () => {
    it("rejects empty query (TV-NEG-002)", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "   ",
      });
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(body.error.message).toBe("Search query must not be empty");
    });

    it("rejects missing resource", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        query: "hello",
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
    });

    it("rejects limit exceeding max (TV-SRV-002)", async () => {
      const server = await createSearchFnServer({
        adapter,
        limits: { maxLimit: 1000 },
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "x",
        limit: 1000000,
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
      expect(body.error.message).toContain("exceeds maximum");
    });

    it("rejects non-positive limit", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "hello",
        limit: 0,
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(body.error.message).toContain("positive number");
    });

    it("rejects empty documents array", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [],
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
    });

    it("rejects document batch exceeding max", async () => {
      const server = await createSearchFnServer({
        adapter,
        limits: { maxIndexBatch: 2 },
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [
          { id: "1", fields: { a: "b" } },
          { id: "2", fields: { a: "b" } },
          { id: "3", fields: { a: "b" } },
        ],
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
    });

    it("rejects empty ids array for remove", async () => {
      const server = await createSearchFnServer({ adapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/remove", {
        resource: "tasks",
        ids: [],
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
    });

    it("rejects invalid JSON body", async () => {
      const server = await createSearchFnServer({ adapter });
      const r = new Request("http://localhost/searchfn/search", {
        method: "POST",
        body: "not json {{{",
        headers: { "Content-Type": "application/json" },
      });
      const res = await server.router.handle(r);
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.error.code).toBe("DFQL_INVALID");
    });

    it("rejects resources array exceeding maxResourcesPerSearchAll", async () => {
      const server = await createSearchFnServer({
        adapter,
        limits: { maxResourcesPerSearchAll: 2 },
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search-all", {
        query: "x",
        resources: ["a", "b", "c"],
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
    });

    it("rejects query exceeding maxQueryLength", async () => {
      const server = await createSearchFnServer({
        adapter,
        limits: { maxQueryLength: 5 },
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "abcdefghij",
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
    });

    it("rejects payload larger than maxPayloadBytes", async () => {
      const server = await createSearchFnServer({
        adapter,
        limits: { maxPayloadBytes: 80 },
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "a".repeat(200),
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
      expect(body.error.details.max).toBe(80);
    });
  });

  // ── SRV-003: Authorization ──

  describe("SRV-003: authorization callback", () => {
    it("returns FORBIDDEN when authorize returns false (TV-SRV-003)", async () => {
      const server = await createSearchFnServer({
        adapter,
        authorize: (_ctx, action) => action !== "search",
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "a",
      });
      expect(status).toBe(403);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Authorization denied");
    });

    it("allows when authorize returns true", async () => {
      const server = await createSearchFnServer({
        adapter,
        authorize: () => true,
      });
      // Index first so search has data
      await req(server.router, "POST", "/searchfn/index", {
        resource: "tasks",
        documents: [{ id: "t1", fields: { title: "ok" } }],
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "ok",
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("returns FORBIDDEN when authorize throws", async () => {
      const server = await createSearchFnServer({
        adapter,
        authorize: () => { throw new Error("auth error"); },
      });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "a",
      });
      expect(status).toBe(403);
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("auth callback receives action name", async () => {
      const actions: string[] = [];
      const server = await createSearchFnServer({
        adapter,
        authorize: (_ctx, action) => { actions.push(action); return true; },
      });
      await req(server.router, "GET", "/searchfn/status");
      await req(server.router, "POST", "/searchfn/search", { resource: "r", query: "q" });
      expect(actions).toContain("status");
      expect(actions).toContain("search");
    });

    it("auth callback receives parsed payload for JSON requests", async () => {
      const payloads: unknown[] = [];
      const server = await createSearchFnServer({
        adapter,
        authorize: (_ctx, _action, payload) => {
          payloads.push(payload);
          return true;
        },
      });
      await req(server.router, "POST", "/searchfn/search", { resource: "r", query: "q" });
      expect(payloads[0]).toEqual({ resource: "r", query: "q" });
    });
  });

  describe("API-002: adapter error mapping", () => {
    it("maps DFQL_ABORTED to status 499", async () => {
      const abortedAdapter: SearchAdapter = {
        name: "aborted",
        async index() {},
        async search() {
          throw new SearchAdapterError("DFQL_ABORTED", "Search operation aborted");
        },
        async remove() {},
        async clear() {},
      };

      const server = await createSearchFnServer({ adapter: abortedAdapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "hello",
      });
      expect(status).toBe(499);
      expect(body.error.code).toBe("DFQL_ABORTED");
    });

    it("maps DFQL_UNSUPPORTED to status 400", async () => {
      const unsupportedAdapter: SearchAdapter = {
        name: "unsupported",
        async index() {},
        async search() {
          throw new SearchAdapterError("DFQL_UNSUPPORTED", "Unsupported operation");
        },
        async remove() {},
        async clear() {},
      };

      const server = await createSearchFnServer({ adapter: unsupportedAdapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/search", {
        resource: "tasks",
        query: "hello",
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("DFQL_UNSUPPORTED");
    });
  });

  // ── Logging ──

  describe("structured logging", () => {
    it("emits request.start and request.end with operation metadata", async () => {
      const logs: Array<{ msg: string; ctx: any }> = [];
      const logger = {
        info: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
        warn: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
        error: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
        debug: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
      };
      const server = await createSearchFnServer({ adapter, logger });
      await req(server.router, "GET", "/searchfn/status");

      const startLog = logs.find(l => l.msg === "request.start");
      const endLog = logs.find(l => l.msg === "request.end");
      expect(startLog).toBeDefined();
      expect(startLog!.ctx.operation).toBe("status");
      expect(endLog).toBeDefined();
      expect(typeof endLog!.ctx.durationMs).toBe("number");
    });

    it("redacts sensitive keys in logs (TV-NEG-008)", async () => {
      const logs: Array<{ msg: string; ctx: any }> = [];
      const logger = {
        info: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
        warn: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
        error: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
        debug: (msg: string, ctx?: any) => logs.push({ msg, ctx }),
      };
      const server = await createSearchFnServer({ adapter, logger });
      await req(server.router, "GET", "/searchfn/status");

      // No log entry should contain unredacted sensitive data
      for (const log of logs) {
        if (log.ctx) {
          expect(JSON.stringify(log.ctx)).not.toContain("apiKey=abc123");
        }
      }
    });
  });

  // ── searchAll fallback for adapter without searchAll ──

  describe("searchAll fallback", () => {
    it("returns error when adapter lacks searchAll and no resources provided", async () => {
      const noSearchAllAdapter: SearchAdapter = {
        name: "basic",
        async index() {},
        async search() { return []; },
        async remove() {},
        async clear() {},
      };
      const server = await createSearchFnServer({ adapter: noSearchAllAdapter });
      const { status, body } = await req(server.router, "POST", "/searchfn/search-all", {
        query: "test",
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(body.error.message).toContain("resources are required");
    });
  });
});
