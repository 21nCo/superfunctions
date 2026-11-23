---
title: Connect a client
description: Production stdio and Streamable HTTP sessions, inventories, calls, and OAuth completion.
---

Install `@mcpfn/client` and choose a target. The client uses the official MCP SDK for protocol and transport behavior.

```ts
import { createMcpFnClient, streamableHttpTarget } from "@mcpfn/client";

const client = createMcpFnClient({
  target: streamableHttpTarget("https://api.example.com/mcp"),
});

try {
  await client.connect();
  const tools = await client.tools.listAll();
  const result = await client.tools.call("status", {});
  console.log(tools, result);
} finally {
  await client.close();
}
```

The main `@mcpfn/client` entry is remote-only and also runs on Cloudflare Workers without `nodejs_compat`. For a locally launched server on Node.js, import `stdioTarget` from `@mcpfn/client/stdio` and use `stdioTarget({ command: "node", args: ["./server.js"] })`; `command` is required, and `args`, `cwd`, and `env` follow the official SDK stdio parameters. `listAll()` follows inventory pagination; `listBounded(limit)` continues pagination but retains only the requested number of entries and reports dropped items. The client also exposes typed resources, prompts, completions, and task methods.

`stdioTarget` exported from the main `@mcpfn/client` entry is deprecated and removed in 0.2.0. Until then it loads `@mcpfn/client/stdio` on Node.js when the target opens; on Workers, opening it fails with `MCPFN_TARGET_OPEN_FAILED`.

## Authorization and lifecycle

Pass an official `OAuthClientProvider` to a Streamable HTTP target. `@mcpfn/auth` supplies one that checks registered redirects and correlates callback state. When interactive authorization is needed, `connect()` reports `MCPFN_AUTHORIZATION_REQUIRED`. Complete the browser callback with both values:

```ts
await client.completeAuthorization({ code, state });
```

McpFn reconnects after the SDK exchange. Connection retries happen only when configured, and capability calls are never replayed implicitly. Register `handlers.roots`, `handlers.sampling`, or `handlers.elicitation` to advertise client-mediated capabilities. `onEvent()` (or the `events` option) observes redacted capability events such as progress, logging, list changes, and client-mediated requests; the `diagnostics` option or `onDiagnostic()` observes redacted lifecycle phases such as connect, authorization, token exchange, and close. The [client reference](/docs/reference/client) documents the target and event surfaces.
