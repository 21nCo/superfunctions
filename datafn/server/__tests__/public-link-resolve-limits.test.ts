/**
 * DFN-22: public-link resolve keeps token access and bounds the body.
 * A stream with no Content-Length is rejected before the handler runs.
 */
import { afterEach, describe, expect, it } from "vitest";
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
    return { status: response.status, raw, body: raw ? JSON.parse(raw) : null };
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

  async function resolve(server: Server, token: string) {
    return read(await server.router.handle(
      new Request("http://localhost/datafn/public-links/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      {},
    ));
  }

  it("rejects an over-limit stream that has no Content-Length", async () => {
    const server = await start({ limits: { maxPayloadBytes: 32 } });
    const request = streamRequest(128);
    expect(request.headers.get("content-length")).toBeNull();
    const result = await read(await server.router.handle(request, {}));
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe("LIMIT_EXCEEDED");
    expect(result.raw).not.toContain("Public link is invalid or revoked");
  });

  it("resolves a valid token without placement", async () => {
    const server = await start();
    const token = await createToken(server);
    const result = await resolve(server, token);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.result.resource).toBe("linkTag");
  });

  it("resolves a valid token when placement is configured", async () => {
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
  });

  it("rate limits resolve without blocking the first token use", async () => {
    const limited = await start({
      rateLimit: { enabled: true, maxRequests: 1, windowSeconds: 60 },
    });
    const token = await createToken(limited);
    const first = await resolve(limited, token);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const second = await resolve(limited, token);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("RATE_LIMITED");

    const open = await start({ rateLimit: { enabled: false } });
    const openToken = await createToken(open);
    const again = await resolve(open, openToken);
    const third = await resolve(open, openToken);
    expect(again.status).toBe(200);
    expect(third.status).toBe(200);
  });
});
