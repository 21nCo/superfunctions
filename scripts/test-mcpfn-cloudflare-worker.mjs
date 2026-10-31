#!/usr/bin/env node

// Representative Cloudflare Workers (workerd) startup + tool-call regression for
// McpFn. It bundles a Worker that imports the built @mcpfn/core and @mcpfn/auth
// alongside a root `zod` import (the mixed-entry-point shape that broke
// Skillplane), boots it under workerd via Miniflare, and drives a real MCP
// client through the authenticated endpoint.
//
// This gate would fail on the pre-fix behavior in two ways:
//   1. The published bundle leaked a `zod/v4` entry point next to the consumer's
//      root `zod`, which esbuild could initialize out of order and throw
//      `TypeError: Class2 is not a constructor` at workerd startup.
//   2. Tool/prompt registration compiled JSON Schemas with Ajv, whose runtime
//      `new Function` is forbidden by workerd, so any tool-serving Worker failed.
//
// A dry-run bundle is not enough: the failures only appear once workerd actually
// executes the Worker, so this test starts it and exercises tools/call.

import assert from "node:assert/strict";
import { build } from "esbuild";
import { builtinModules, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Cloudflare's `nodejs_compat` provides Node built-ins at runtime; keep them
// external at bundle time exactly as Wrangler does.
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "cloudflare:workers",
];

const workerSource = `
import { z } from "zod";
import {
  McpFnRegistry,
  createMcpFnServer,
  schemaEngine,
  structuredResult,
  validateManifest,
} from "@mcpfn/core";
import {
  createOAuthResourceServerHandler,
  createProtectedResourceMetadata,
} from "@mcpfn/auth";

// A consumer that also uses root \`zod\` — the mixed-entry-point shape.
const AddInput = z.object({ left: z.number(), right: z.number() });
const resource = new URL("https://worker.example/mcp");
const protectedResource = createProtectedResourceMetadata({
  resource,
  authorizationServers: ["https://auth.example"],
  scopesSupported: ["tools:call"],
});

let unresolvedReferenceRejection;
try {
  new McpFnRegistry().register({
    name: "invalid-reference",
    description: "Must fail during Worker module startup.",
    inputSchema: {
      type: "object",
      properties: { value: { $ref: "https://worker.example/schemas/missing" } },
    },
    handler: async () => structuredResult({ ok: true }),
  });
} catch (error) {
  const cause = error?.details?.cause;
  unresolvedReferenceRejection = {
    rejected: true,
    cause: typeof cause === "string" ? cause : String(error),
  };
}

const registry = new McpFnRegistry().register({
  name: "pair-shape",
  description: "Validate a pair of numbers.",
  inputSchema: {
    $id: "https://worker.example/schemas/pair",
    type: "object",
    additionalProperties: false,
    required: ["left", "right"],
    properties: { left: { type: "number" }, right: { type: "number" } },
  },
  handler: async ({ left, right }) => structuredResult({ left, right }),
}).register({
  name: "add",
  description: "Add two numbers.",
  inputSchema: {
    type: "object",
    $ref: "https://worker.example/schemas/pair",
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["result"],
    properties: { result: { type: "number" } },
  },
  handler: async ({ left, right }) => {
    // Prove the consumer's root zod runs in the same isolate.
    AddInput.parse({ left, right });
    return structuredResult({ result: left + right });
  },
}).register({
  name: "opaque-uri",
  description: "Validate a relative reference beneath a URN schema ID.",
  inputSchema: {
    $id: "urn:example:root",
    type: "object",
    required: ["value"],
    $defs: { child: { $id: "child", type: "string" } },
    properties: { value: { $ref: "child" } },
  },
  handler: async ({ value }) => structuredResult({ value }),
}).register({
  name: "ipvfuture-uri",
  description: "Validate a relative reference beneath an IPvFuture schema ID.",
  inputSchema: {
    $id: "https://[v1.fe]/schema",
    type: "object",
    required: ["value"],
    $defs: { child: { $id: "child", type: "string" } },
    properties: { value: { $ref: "child" } },
  },
  handler: async ({ value }) => structuredResult({ value }),
}).register({
  name: "recursive",
  description: "Validate an anonymous dot-segment self reference.",
  inputSchema: { type: "object", properties: { child: { $ref: "." } } },
  handler: async (args) => structuredResult(args),
}).register({
  name: "fragment",
  description: "Validate a named fragment beneath an anonymous root.",
  inputSchema: {
    type: "object",
    definitions: { value: { $id: "#value", type: "string" } },
    properties: { value: { $ref: "#value" } },
  },
  handler: async ({ value }) => structuredResult({ value }),
});

const mcp = createMcpFnServer({
  info: { name: "cloudflare-regression", version: "1.0.0" },
  registry,
});
const manifest = validateManifest(mcp.manifest());

const handlerPromise = mcp.createWebStandardHandler({
  enableJsonResponse: true,
  sessionIdGenerator: () => crypto.randomUUID(),
});
const protectedHandlerPromise = handlerPromise.then((handler) =>
  createOAuthResourceServerHandler(handler, {
    resource,
    authorizationServers: ["https://auth.example"],
    requiredScopes: ["tools:call"],
    verifier: {
      async verifyAccessToken(token) {
        return {
          token,
          clientId: "cloudflare-regression-client",
          extra: { subject: "cloudflare-regression-service" },
          scopes: ["tools:call"],
          resource,
        };
      },
    },
  }),
);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/diagnostics") {
      return Response.json({
        schemaEngine,
        protectedResource,
        manifestHash: manifest.hash,
        unresolvedReferenceRejection,
      });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const handler = await protectedHandlerPromise;
    return handler(request);
  },
};
`;

function consumerZod(manifest, version) {
  const require = createRequire(path.resolve(repoRoot, manifest));
  const packagePath = require.resolve("zod/package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  assert.equal(metadata.version, version, "Unexpected consumer Zod fixture version");
  return { version, entry: path.resolve(path.dirname(packagePath), metadata.exports["."].import) };
}

async function bundleWorker(consumer) {
  const result = await build({
    stdin: {
      // Resolve only the consumer's root import; do not alias or mask imports
      // leaking from the MCP outputs. Both fixture copies are already installed.
      contents: workerSource.replace('from "zod";', `from ${JSON.stringify(consumer.entry)};`),
      resolveDir: repoRoot,
      sourcefile: "cloudflare-regression-worker.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser", "import"],
    external: nodeExternals,
  });
  return { code: result.outputFiles[0].text, metafile: result.metafile };
}

function assertSelfContainedZod(metafile) {
  const inputs = Object.keys(metafile.inputs);
  const packageOutputs = inputs.filter(input =>
    /(?:^|\/)mcpfn\/(?:core|auth)\/dist\//.test(input) ||
    /(?:^|\/)node_modules\/@mcpfn\/(?:core|auth)\/dist\//.test(input));
  for (const name of ["core", "auth"]) {
    assert(packageOutputs.some(input => input.includes(`/${name}/dist/`)),
      `Worker did not consume the built @mcpfn/${name} output`);
  }

  // A consumer's Zod 4 root legitimately imports zod/v4. Only dependency
  // edges reachable from MCP's built outputs must remain self-contained.
  const pending = [...packageOutputs];
  const visited = new Set();
  while (pending.length) {
    const origin = pending.pop();
    if (visited.has(origin)) continue;
    visited.add(origin);
    for (const edge of metafile.inputs[origin]?.imports ?? []) {
      for (const specifier of [edge.path, edge.original].filter(Boolean)) {
        assert(!/(?:^|\/)(?:zod|@modelcontextprotocol\/sdk)(?:\/|$)/.test(specifier),
          `Built MCP dependency escaped its bundle: ${origin} -> ${specifier}`);
      }
      if (!edge.external && metafile.inputs[edge.path]) pending.push(edge.path);
    }
  }
}

async function checkConsumer(consumer) {
  const { code, metafile } = await bundleWorker(consumer);
  assertSelfContainedZod(metafile);

  const mf = new Miniflare({
    port: 0,
    compatibilityDate: "2026-09-13",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.js", contents: code }],
  });

  let client;
  try {
    const url = await mf.ready; // workerd is up and the module has been evaluated.
    const endpoint = new URL("/mcp", url);
    const diagnosticsResponse = await fetch(new URL("/diagnostics", url));
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(
      diagnostics.schemaEngine,
      "cfworker",
      `Worker selected ${diagnostics.schemaEngine} instead of the edge validator`,
    );
    assert.match(diagnostics.manifestHash, /^[a-f0-9]{64}$/);
    assert.equal(
      diagnostics.unresolvedReferenceRejection?.rejected,
      true,
      "Worker accepted an unresolved schema reference during module startup",
    );
    assert.match(
      diagnostics.unresolvedReferenceRejection.cause,
      /resolve.*ref/i,
      "Worker rejected the invalid schema for an unexpected reason",
    );
    assert.deepEqual(diagnostics.protectedResource, {
      resource: "https://worker.example/mcp",
      authorization_servers: ["https://auth.example"],
      scopes_supported: ["tools:call"],
      bearer_methods_supported: ["header"],
    });

    client = new Client({ name: "cloudflare-regression-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: "Bearer worker-test-token" } },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.ok(
      tools.some((tool) => tool.name === "add"),
      "Worker did not advertise the 'add' tool",
    );

    const result = await client.callTool({ name: "add", arguments: { left: 2, right: 3 } });
    assert.deepEqual(
      result.structuredContent,
      { result: 5 },
      `Unexpected tool result: ${JSON.stringify(result)}`,
    );

    const invalid = await client.callTool({
      name: "add",
      arguments: { left: "2", right: 3 },
    });
    assert.equal(invalid.isError, true, "Worker accepted invalid tool arguments");
    assert.match(
      invalid.content[0]?.text ?? "",
      /MCPFN_INVALID_ARGUMENTS/,
      `Unexpected validation result: ${JSON.stringify(invalid)}`,
    );

    const opaque = await client.callTool({ name: "opaque-uri", arguments: { value: "ok" } });
    assert.deepEqual(opaque.structuredContent, { value: "ok" });
    const opaqueInvalid = await client.callTool({ name: "opaque-uri", arguments: { value: 42 } });
    assert.equal(opaqueInvalid.isError, true, "Worker accepted an invalid opaque-URI value");
    const ipvFuture = await client.callTool({ name: "ipvfuture-uri", arguments: { value: "ok" } });
    assert.deepEqual(ipvFuture.structuredContent, { value: "ok" });
    const ipvFutureInvalid = await client.callTool({ name: "ipvfuture-uri", arguments: { value: 42 } });
    assert.equal(ipvFutureInvalid.isError, true, "Worker accepted an invalid IPvFuture value");
    const recursive = await client.callTool({ name: "recursive", arguments: { child: { child: {} } } });
    assert.deepEqual(recursive.structuredContent, { child: { child: {} } });
    const recursiveInvalid = await client.callTool({ name: "recursive", arguments: { child: 42 } });
    assert.equal(recursiveInvalid.isError, true, "Worker accepted an invalid recursive value");
    const fragment = await client.callTool({ name: "fragment", arguments: { value: "ok" } });
    assert.deepEqual(fragment.structuredContent, { value: "ok" });
    const fragmentInvalid = await client.callTool({ name: "fragment", arguments: { value: 42 } });
    assert.equal(fragmentInvalid.isError, true, "Worker accepted an invalid named-fragment value");

    process.stdout.write(
      JSON.stringify({
        ok: true,
        gate: "mcpfn cloudflare worker startup",
        runtime: "workerd",
        consumerZod: consumer.version,
        schemaEngine: diagnostics.schemaEngine,
        auth: "@mcpfn/auth",
        tool: "add",
        result: 5,
        opaqueUri: true,
        ipvFutureUri: true,
        recursiveUri: true,
        namedFragmentUri: true,
      }) + "\n",
    );
  } finally {
    try { await client?.close(); } finally { await mf.dispose(); }
  }
}

try {
  for (const consumer of [
    consumerZod("package.json", "3.25.76"),
    consumerZod("mcpfn/core/package.json", "4.6.6"),
  ]) {
    await checkConsumer(consumer);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  );
  process.exitCode = 1;
}
