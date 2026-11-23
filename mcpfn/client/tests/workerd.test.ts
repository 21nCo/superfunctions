// Cloudflare Workers (workerd) acceptance for the remote-only main entry.
//
// The Worker is bundled from the built package exactly as Wrangler resolves it
// (`workerd`/`worker`/`browser` conditions, no Node built-ins marked external),
// then runs under Miniflare with `nodejs_compat` off. Before the split, the
// main entry imported the SDK stdio transport, so this bundle pulled in
// `cross-spawn` and `child_process` and could not be built for workerd.
import { existsSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Metafile } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";

import { declaredDialectTools, runSchemaParityCases } from "./fixtures/schema-parity.mjs";
import { handleSchemaParityRequest } from "./fixtures/schema-parity-server.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const builtEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
// esbuild reports real paths; compare against real paths (macOS /var -> /private/var).
const builtFile = (file: string) =>
  realpathSync(fileURLToPath(new URL(`../dist/${file}`, import.meta.url)));

const workerSource = `
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createMcpFnClient, stdioTarget, streamableHttpTarget } from "@mcpfn/client";
import { declaredDialectCases, runSchemaParityCases } from "./tests/fixtures/schema-parity.mjs";

async function run(endpoint) {
  const events = [];
  const client = createMcpFnClient({
    target: streamableHttpTarget(endpoint),
    diagnostics: (event) => { events.push(event); },
  });
  try {
    await client.connect();
    const tools = await client.tools.listAll();
    const added = await client.tools.call("add", { left: 2, right: 3 });
    return {
      state: client.state,
      tools: tools.map((tool) => tool.name).sort(),
      structuredContent: added.structuredContent,
      requestIds: [...new Set(events.map((event) => event.requestId))],
    };
  } finally {
    await client.close();
  }
}

// The SDK default (Ajv) compiles tool output schemas with \`new Function\`,
// which workerd rejects while handling a request.
async function runWithAjv(endpoint) {
  const client = createMcpFnClient({
    target: streamableHttpTarget(endpoint),
    clientOptions: { jsonSchemaValidator: new AjvJsonSchemaValidator() },
  });
  try {
    await client.connect();
    await client.tools.listAll();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.cause ?? error) };
  } finally {
    await client.close();
  }
}

async function runDeprecatedStdio() {
  const client = createMcpFnClient({ target: stdioTarget({ command: "node" }) });
  try {
    await client.connect();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.cause ?? error) };
  } finally {
    await client.close();
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const endpoint = url.searchParams.get("endpoint");
    try {
      if (url.pathname === "/remote") return Response.json(await run(endpoint));
      if (url.pathname === "/ajv") return Response.json(await runWithAjv(endpoint));
      if (url.pathname === "/stdio") return Response.json(await runDeprecatedStdio());
      if (url.pathname === "/schemas") {
        return Response.json(
          await runSchemaParityCases({ createMcpFnClient, streamableHttpTarget }, endpoint),
        );
      }
      if (url.pathname === "/dialects") {
        return Response.json(
          await runSchemaParityCases(
            { createMcpFnClient, streamableHttpTarget },
            endpoint,
            declaredDialectCases,
          ),
        );
      }
      return new Response("Not found", { status: 404 });
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
    logLevel: "silent",
  });
  return { code: result.outputFiles[0]!.text, metafile: result.metafile };
}

async function startMcpServer() {
  const mcp = createMcpFnServer({
    info: { name: "mcpfn-workerd-fixture", version: "1.0.0" },
    registry: new McpFnRegistry()
      .register({
        name: "add",
        description: "Add two numbers.",
        inputSchema: {
          type: "object",
          required: ["left", "right"],
          properties: { left: { type: "number" }, right: { type: "number" } },
        },
        outputSchema: {
          type: "object",
          required: ["result"],
          properties: { result: { type: "number" } },
        },
        handler: async ({ left, right }) =>
          structuredResult({ result: (left as number) + (right as number) }),
      })
      .register({
        name: "echo",
        description: "Echo an input.",
        inputSchema: { type: "object" },
        handler: async (input) => structuredResult(input),
      }),
  });
  const handler = await mcp.createWebStandardHandler({ enableJsonResponse: true });
  return { mcp, server: await serveWebHandler(handler) };
}

/** Serves a Web-standard request handler over Node.js HTTP on a free port. */
async function serveWebHandler(handler: (request: Request) => Promise<Response>) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        headers.append(key, entry);
      }
    }
    const webResponse = await handler(new Request(
      new URL(request.url ?? "/", `http://${request.headers.host}`),
      { method: request.method, headers, ...(body.length ? { body } : {}) },
    ));
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function endpointOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe("@mcpfn/client on Cloudflare Workers (workerd)", () => {
  let metafile: Metafile;
  let miniflare: Miniflare;
  let mcpServer: Awaited<ReturnType<typeof startMcpServer>>;
  let endpoint: string;
  let parityServer: Server;
  let parityEndpoint: string;
  let dialectServer: Server;
  let dialectEndpoint: string;

  beforeAll(async () => {
    if (!existsSync(builtEntry)) {
      throw new Error("Build @mcpfn/client (npm run build) before the workerd test");
    }
    const bundle = await bundleWorker();
    metafile = bundle.metafile;
    mcpServer = await startMcpServer();
    endpoint = endpointOf(mcpServer.server);
    parityServer = await serveWebHandler(handleSchemaParityRequest);
    parityEndpoint = endpointOf(parityServer);
    dialectServer = await serveWebHandler((request) =>
      handleSchemaParityRequest(request, declaredDialectTools),
    );
    dialectEndpoint = endpointOf(dialectServer);
    miniflare = new Miniflare({
      compatibilityDate: "2025-11-01",
      compatibilityFlags: [],
      modules: [{ type: "ESModule", path: "worker.js", contents: bundle.code }],
    });
    await miniflare.ready;
  }, 60_000);

  afterAll(async () => {
    await miniflare?.dispose();
    await mcpServer?.mcp.close();
    for (const server of [mcpServer?.server, parityServer, dialectServer]) {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  });

  async function workerJson<T = Record<string, unknown>>(
    path: string,
    target = endpoint,
  ): Promise<T> {
    const url = new URL(path, "http://worker.test");
    url.searchParams.set("endpoint", target);
    const response = await miniflare.dispatchFetch(url);
    const body = (await response.json()) as T;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }

  it("bundles the remote entry without stdio, cross-spawn or Node built-ins", () => {
    const inputs = Object.keys(metafile.inputs).map((input) =>
      input.includes(":") && !path.isAbsolute(input) ? input : path.resolve(packageRoot, input),
    );
    expect(inputs).toContain(builtFile("index.js"));
    expect(inputs).not.toContain(builtFile("stdio.js"));
    expect(inputs.filter((input) =>
      /cross-spawn|child_process|node:stream|[\\/]client[\\/]stdio\.js$|[\\/]shared[\\/]stdio\.js$/
        .test(input),
    )).toEqual([]);
    // The deprecated main-entry stdioTarget resolves `#stdio-target` to the
    // stub without the `node` condition.
    expect(inputs).toContain(builtFile("stdio-unavailable.js"));
    const imports = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.map((entry) => entry.path),
    );
    expect(imports).toEqual([]);
  });

  it("connects over Streamable HTTP and runs listTools and callTool", async () => {
    const result = await workerJson("/remote");
    expect(result).toMatchObject({
      state: "connected",
      tools: ["add", "echo"],
      structuredContent: { result: 5 },
    });
    const requestIds = result.requestIds as string[];
    expect(requestIds.length).toBeGreaterThan(1);
    for (const requestId of requestIds) {
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  }, 30_000);

  it("needs the edge validator: the SDK's Ajv default fails on output schemas", async () => {
    const result = await workerJson("/ajv");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Code generation from strings disallowed/);
  }, 30_000);

  it("validates undeclared-dialect output schemas with draft-07 features as the Node.js default does", async () => {
    type Verdict = { tool: string; value: unknown; accepted: boolean; message?: string };
    // Node.js: the same built entry with the SDK's default (Ajv) validator.
    const nodeClient = await import(builtEntry);
    const onNode = (await runSchemaParityCases(nodeClient, parityEndpoint)) as Verdict[];
    const onWorkerd = await workerJson<Verdict[]>("/schemas", parityEndpoint);
    const verdicts = (results: Verdict[]) =>
      results.map(({ tool, value, accepted }) => ({ tool, value, accepted }));

    expect(verdicts(onWorkerd)).toEqual(verdicts(onNode));
    // The maximum beside the $ref applies (a draft-7 cfworker validator would
    // ignore it and accept 50), and the tuple rejects a wrong or extra item.
    expect(onNode.map((result) => result.accepted)).toEqual([true, false, true, false, false]);
    for (const result of [...onNode, ...onWorkerd].filter((entry) => !entry.accepted)) {
      expect(result.message).toMatch(/does not match the tool's output schema/);
    }
  }, 30_000);

  it("validates tool output schemas with the dialect their $schema declares", async () => {
    type Verdict = { tool: string; value: unknown; accepted: boolean; message?: string };
    const onWorkerd = await workerJson<Verdict[]>("/dialects", dialectEndpoint);
    expect(onWorkerd.map(({ tool, value, accepted }) => ({ tool, value, accepted }))).toEqual([
      // Draft-07 ignores the minLength beside the $ref; the $ref target still applies.
      { tool: "draft07-ref-sibling", value: "a", accepted: true },
      { tool: "draft07-ref-sibling", value: 5, accepted: false },
      // Draft-04 boolean exclusiveMinimum excludes the minimum itself.
      { tool: "draft04-exclusive-minimum", value: 5, accepted: false },
      { tool: "draft04-exclusive-minimum", value: 6, accepted: true },
      { tool: "draft2020-prefix-items", value: ["a"], accepted: true },
      { tool: "draft2020-prefix-items", value: ["a", 1], accepted: false },
      // An unsupported dialect fails explicitly instead of using another draft.
      { tool: "draft06-unsupported", value: 1, accepted: false },
    ]);
    for (const result of onWorkerd.filter((entry) => !entry.accepted)) {
      expect(result.message).toMatch(/does not match the tool's output schema/);
    }
    expect(onWorkerd.at(-1)!.message).toMatch(
      /unsupported JSON Schema dialect "http:\/\/json-schema.org\/draft-06\/schema#"/,
    );
  }, 30_000);

  it("fails the deprecated stdio compatibility target cleanly when opened", async () => {
    expect(await workerJson("/stdio")).toMatchObject({
      ok: false,
      code: "MCPFN_TARGET_OPEN_FAILED",
      message: expect.stringContaining('import stdioTarget from "@mcpfn/client/stdio"'),
    });
  }, 30_000);
});
