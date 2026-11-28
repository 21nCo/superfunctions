// Cloudflare Workers (workerd) acceptance for a server built with the adapter.
//
// The Worker is bundled from the adapter source, @mcpfn/core and the
// @datafn/server in this package's peer range (the devDependency), exactly as
// Wrangler resolves them (`workerd`/`worker`/`browser` conditions, Node.js
// built-ins left to the runtime as with `nodejs_compat`), then runs under
// Miniflare. Requests carry the session's scopes the way a host's
// authentication would hand them over (as validated `authInfo`).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const workerSource = `
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createMcpFnServer, structuredResult } from "@mcpfn/core";
import { createDatafnMcpAdapter } from "./src/index.ts";

const schema = {
  resources: [{
    name: "notes",
    version: 1,
    fields: [{ name: "title", type: "string", required: true }],
    permissions: { read: { fields: ["title"] }, write: { fields: ["title"] } },
  }],
};

let handler;
async function mcpHandler() {
  if (handler) return handler;
  const datafn = await createDatafnServer({ schema, db: memoryAdapter() });
  const adapter = createDatafnMcpAdapter({
    executor: datafn.executor,
    context: () => undefined,
    clientId: (session) => "mcp:" + session.clientId,
    sessionScopes: (session) => session.scopes,
    expose: {
      notes: {
        fields: ["id", "title"],
        scopes: { read: ["memotron:read"], write: ["memotron:write"] },
        create: { fields: ["title"] },
        update: { fields: ["title"] },
      },
    },
  });
  adapter.registerTool({
    name: "memotron_ping",
    description: "A host domain tool beside the generated ones.",
    inputSchema: { type: "object" },
    handler: async () => structuredResult({ pong: true }),
  });
  const server = createMcpFnServer({
    info: { name: "datafn-workerd-fixture", version: "1.0.0" },
    registry: adapter.registry,
    toolVisibility: adapter.toolVisibility,
    context: (extra) => ({
      clientId: extra.authInfo?.clientId ?? "anonymous",
      scopes: extra.authInfo?.scopes ?? [],
    }),
  });
  handler = await server.createWebStandardHandler({ enableJsonResponse: true });
  return handler;
}

export default {
  async fetch(request) {
    try {
      const header = request.headers.get("x-test-scopes") ?? "";
      const scopes = header ? header.split(" ") : [];
      const serve = await mcpHandler();
      return await serve(request, {
        authInfo: { token: "test-session", clientId: "test-client", scopes },
      });
    } catch (error) {
      return Response.json({ error: String(error?.stack ?? error) }, { status: 500 });
    }
  },
};
`;

async function bundleWorker(): Promise<{ code: string; metafile: Metafile }> {
  const result = await build({
    stdin: { contents: workerSource, resolveDir: packageRoot, sourcefile: "worker.js" },
    absWorkingDir: packageRoot,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser", "import"],
    // DataFn and the memory adapter use `crypto`; nodejs_compat provides it.
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    logLevel: "silent",
  });
  return { code: result.outputFiles[0]!.text, metafile: result.metafile };
}

describe("a DataFn McpFn server on Cloudflare Workers (workerd)", () => {
  let miniflare: Miniflare;
  let metafile: Metafile;
  let requestId = 0;

  beforeAll(async () => {
    const bundle = await bundleWorker();
    metafile = bundle.metafile;
    miniflare = new Miniflare({
      compatibilityDate: "2025-11-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "worker.js", contents: bundle.code }],
    });
    await miniflare.ready;
  }, 60_000);

  afterAll(async () => {
    await miniflare?.dispose();
  });

  async function rpc(scopes: string[], method: string, params: Record<string, unknown> = {}) {
    const response = await miniflare.dispatchFetch("http://worker.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "x-test-scopes": scopes.join(" "),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = (await response.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }

  async function toolNames(scopes: string[]) {
    const { result } = await rpc(scopes, "tools/list");
    return (result!.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
  }

  async function call(scopes: string[], name: string, args: Record<string, unknown>) {
    const { result } = await rpc(scopes, "tools/call", { name, arguments: args });
    return result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
  }

  it("bundles against a @datafn/server inside the peer range", () => {
    const serverEntries = Object.keys(metafile.inputs)
      .map((input) => path.resolve(packageRoot, input))
      .filter((input) => /[\\/]@datafn[\\/]server[\\/]dist[\\/]/.test(input));
    expect(serverEntries.length).toBeGreaterThan(0);
    const serverRoots = new Set(serverEntries.map((input) => input.replace(/[\\/]dist[\\/].*$/, "")));
    expect(serverRoots.size).toBe(1);
    const [serverRoot] = serverRoots;
    const { version } = JSON.parse(readFileSync(path.join(serverRoot!, "package.json"), "utf8")) as {
      version: string;
    };
    expect(packageJson.peerDependencies["@datafn/server"]).toBe(">=0.1.1 <0.3.0");
    const [major, minor, patch] = version.split(".").map(Number);
    expect(major === 0 && ((minor === 1 && patch! >= 1) || minor === 2), version).toBe(true);
  });

  it("lists only the tools a session's scopes allow", async () => {
    expect(await toolNames([])).toEqual(["memotron_ping"]);
    expect(await toolNames(["memotron:read"])).toEqual([
      "datafn_notes_get",
      "datafn_notes_list",
      "memotron_ping",
    ]);
    expect(await toolNames(["memotron:*"])).toEqual([
      "datafn_notes_create",
      "datafn_notes_get",
      "datafn_notes_list",
      "datafn_notes_update",
      "memotron_ping",
    ]);
  }, 30_000);

  it("runs list, get, create and update for a scoped session and refuses an unscoped one", async () => {
    const writer = ["memotron:read", "memotron:write"];
    const create = { id: "note-1", mutationId: "create-1", record: { title: "First" } };
    const update = { id: "note-1", mutationId: "update-1", record: { title: "Renamed" } };

    for (const [name, args] of [
      ["datafn_notes_create", create],
      ["datafn_notes_update", update],
    ] as const) {
      const refused = await call(["memotron:read"], name, args);
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({
        error: {
          code: "insufficient_scope",
          details: { requiredScopes: ["memotron:write"], missingScopes: ["memotron:write"] },
        },
      });
    }
    for (const [name, args] of [
      ["datafn_notes_list", {}],
      ["datafn_notes_get", { id: "note-1" }],
    ] as const) {
      const refused = await call([], name, args);
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({
        error: { code: "insufficient_scope", details: { missingScopes: ["memotron:read"] } },
      });
    }

    expect((await call(writer, "datafn_notes_create", create)).isError).not.toBe(true);
    expect((await call(writer, "datafn_notes_update", update)).isError).not.toBe(true);
    expect((await call(writer, "datafn_notes_get", { id: "note-1" })).structuredContent).toMatchObject({
      result: { data: [{ id: "note-1", title: "Renamed" }] },
    });
    expect((await call(["memotron:read"], "datafn_notes_list", {})).structuredContent).toMatchObject({
      result: { data: [{ id: "note-1", title: "Renamed" }] },
    });
  }, 30_000);
});
