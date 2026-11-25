/**
 * DFN-22: public-link resolve keeps token access and bounds the body.
 * A stream with no Content-Length is rejected before the handler runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@superfunctions/http";
import {
  createMemoryIndexedDirectoryStore,
  memoryAdapter,
} from "@superfunctions/db/adapters";
import {
  createDatafnPublicLinksPlugin,
  createDatafnServer,
  createMemoryDatafnPlacementDirectory,
  datafnMultiRegionPlugin,
  type DatafnServer,
} from "../src/index.js";
import type { DatafnSchema } from "../src/core-types.js";
import type { DatafnComposableRoute } from "../src/server.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "linkTag",
      version: 1,
      idPrefix: "tag",
      capabilities: [
        "timestamps",
        "audit",
        {
          shareable: {
            levels: ["viewer", "editor", "owner"],
            default: "private",
            supportsScopeGrants: true,
          },
        },
      ] as DatafnSchema["resources"][number]["capabilities"],
      fields: [
        { name: "id", type: "string", required: true },
        { name: "label", type: "string", required: false },
      ],
    },
  ],
  relations: [],
};

type Server = DatafnServer<unknown>;

function publicLinks(directory = createMemoryIndexedDirectoryStore()) {
  return createDatafnPublicLinksPlugin<{ actorId: string }>({
    authenticateOwner: (request) => {
      const actorId = request.headers.get("x-owner-actor");
      return actorId ? { actorId } : null;
    },
    getOwnerActorId: (session) => session.actorId,
    getOwnerNamespace: (actorId) => `user:${actorId}`,
    directory,
    resourceRegion: "region:public-links",
  });
}

describe("public link resolve limits", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  async function start(extra: Record<string, unknown> = {}) {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await createDatafnServer({
      schema,
      database: db,
      allowUnknownResources: true,
      publicLinks: publicLinks(),
      limits: { maxPayloadBytes: 1_048_576 },
      ...extra,
    });
    servers.push(server);
    return server;
  }

  async function read(response: Response) {
    const raw = await response.text();
    return {
      status: response.status,
      raw,
      body: raw ? JSON.parse(raw) : null,
      allowOrigin: response.headers.get("access-control-allow-origin"),
    };
  }

  function streamRequest(bytes: number): Request {
    const payload = new Uint8Array(bytes).fill(0x78);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    return new Request("http://localhost/datafn/public-links/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
  }

  async function createToken(server: Server): Promise<string> {
    const response = await server.router.handle(
      new Request("http://localhost/datafn/public-links", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-actor": "owner",
        },
        body: JSON.stringify({ resource: "linkTag", scope: "resource", level: "viewer" }),
      }),
      {},
    );
    const created = await read(response);
    expect(created.status).toBe(200);
    const token = created.body?.result?.token;
    expect(typeof token).toBe("string");
    return token as string;
  }

  async function resolve(server: Server, token: string, keepalive = false) {
    return read(await server.router.handle(
      new Request("http://localhost/datafn/public-links/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        keepalive,
      }),
      {},
    ));
  }

  it.each(["context factory", "middleware"])("bounds a stream first read by the %s", async (firstReader) => {
    let parsedBody = false;
    const server = await start({
      limits: { maxPayloadBytes: 32 },
      context: firstReader === "context factory" ? async (request: Request) => {
        await request.json();
        parsedBody = true;
        return {};
      } : undefined,
    });
    server.router.use(async (_request, _context, next) => {
      const response = await next();
      response.headers.set("access-control-allow-origin", "https://example.test");
      return response;
    });
    if (firstReader === "middleware") {
      server.router.use(async (_request, context, next) => {
        await context.json();
        parsedBody = true;
        return next();
      });
    }
    const request = streamRequest(128);
    expect(request.headers.get("content-length")).toBeNull();
    const result = await read(await server.router.handle(request, {}));
    expect(result.status).toBe(413);
    expect(result.allowOrigin).toBe(firstReader === "middleware" ? "https://example.test" : null);
    expect(result.body.error.code).toBe("LIMIT_EXCEEDED");
    expect(result.raw).not.toContain("Public link is invalid or revoked");
    expect(parsedBody).toBe(false);
  });

  it("resolves a valid token after middleware parses the bounded body", async () => {
    const server = await start();
    const token = await createToken(server);
    server.router.use(async (request, context, next) => {
      if (request.body) expect(await context.json()).toEqual({ token });
      return next();
    });
    const result = await resolve(server, token);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.result.resource).toBe("linkTag");
    const retained = await resolve(server, token, true);
    expect(retained.status).toBe(200);
    expect(retained.body.result.resource).toBe("linkTag");
    const headerOnly = await read(await server.router.handle(new Request("http://localhost/datafn/public-links/resolve", {
      method: "POST",
      headers: { "x-datafn-public-link-token": token },
    })));
    expect(headerOnly.status).toBe(200);
    expect(headerOnly.body.result.resource).toBe("linkTag");
  });

  it("forwards cancellation when middleware discards a body without reading it", async () => {
    const server = await start();
    let canceled = false;
    server.router.use(async (request) => {
      await request.body?.cancel();
      return new Response(null, { status: 204 });
    });
    const body = new ReadableStream<Uint8Array>({
      cancel() { canceled = true; },
    });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const response = await server.router.handle(new Request("http://localhost/datafn/public-links/resolve", init));
    expect(response.status).toBe(204);
    expect(canceled).toBe(true);
  });

  it("preserves the body cache shared by global middleware and a plugin handler", async () => {
    const route: DatafnComposableRoute<{ actor: string; rateKey: string }> = {
      method: "POST",
      path: "/datafn/example/:id",
      middleware: [async (_request, context, next) => {
        context.rateKey = context.actor;
        return next();
      }],
      handler: async (_request, context) => Response.json({
        id: context.params.id,
        actor: context.actor,
        body: await context.json(),
      }),
    };
    const server = await start({
      context: { actor: "test-actor" },
      rateLimit: {
        enabled: true,
        keyExtractor: (context: { rateKey?: string }) => {
          if (context.rateKey === undefined) throw new Error("Missing caller key");
          return context.rateKey;
        },
      },
      plugins: [{ name: "test-route", runsOn: ["server"], routes: () => [route] }],
    });
    server.router.use(async (_request, context, next) => {
      await context.json();
      return next();
    });
    const result = await read(await server.router.handle(new Request("http://localhost/datafn/example/test-id", {
      method: "POST",
      body: JSON.stringify({ name: "Ada" }),
    })));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: "test-id", actor: "test-actor", body: { name: "Ada" } });
  });

  it("runs plugin response middleware on a handler error with rate limiting disabled", async () => {
    const route: DatafnComposableRoute = {
      method: "GET",
      path: "/datafn/example",
      middleware: [async (_request, _context, next) => {
        const response = await next();
        response.headers.set("x-plugin-response", "decorated");
        return response;
      }],
      handler: () => { throw new ConflictError("Example conflict"); },
    };
    const server = await start({
      plugins: [{ name: "test-route", runsOn: ["server"], routes: () => [route] }],
    });
    const response = await server.router.handle(new Request("http://localhost/datafn/example"));
    expect(response.status).toBe(409);
    expect(response.headers.get("x-plugin-response")).toBe("decorated");
  });

  it("resolves a valid token with placement and rate limits without a namespace lookup", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const directory = createMemoryIndexedDirectoryStore();
    const placement = createMemoryDatafnPlacementDirectory();
    await placement.putIfAbsent({
      namespace: "user:owner",
      regionId: "region:public-links",
      epoch: 1,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const server = await createDatafnServer({
      schema,
      database: db,
      allowUnknownResources: true,
      publicLinks: publicLinks(directory),
      limits: { maxPayloadBytes: 1_048_576 },
      rateLimit: { enabled: true, maxRequests: 1, windowSeconds: 60 },
      plugins: [
        datafnMultiRegionPlugin({
          regionId: "region:public-links",
          directory,
          placement: { directory: placement },
        }),
      ],
    });
    servers.push(server);
    const token = await createToken(server);
    const result = await resolve(server, token);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.result.resource).toBe("linkTag");
    const exhausted = await resolve(server, "test-invalid-link");
    expect(exhausted.status).toBe(429);
  });

  it("rate limits resolve without blocking the first token use", async () => {
    let resolveContextCalls = 0;
    const limited = await start({
      context: (request: Request) => {
        if (new URL(request.url).pathname.endsWith("/resolve")) resolveContextCalls++;
        return {};
      },
      rateLimit: {
        enabled: true,
        maxRequests: 1,
        windowSeconds: 60,
        keyExtractor: (context: { rateKey: string }) => context.rateKey,
      },
    });
    limited.router.use(async (_request, context, next) => {
      Object.assign(context, { rateKey: "test-client" });
      const response = await next();
      response.headers.set("access-control-allow-origin", "https://example.test");
      return response;
    });
    const token = await createToken(limited);
    const first = await resolve(limited, token);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const exhausted = streamRequest(128);
    const second = await read(await limited.router.handle(exhausted));
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("RATE_LIMITED");
    expect(second.allowOrigin).toBe("https://example.test");
    expect(exhausted.bodyUsed).toBe(false);
    expect(resolveContextCalls).toBe(2);

    const open = await start({ rateLimit: { enabled: false } });
    const openToken = await createToken(open);
    const again = await resolve(open, openToken);
    const third = await resolve(open, openToken);
    expect(again.status).toBe(200);
    expect(third.status).toBe(200);
  });
});
