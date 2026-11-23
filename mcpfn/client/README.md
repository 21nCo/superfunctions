# `@mcpfn/client`

Production MCP client and headless session engine for Node.js 18.18 or newer
and Cloudflare Workers. It delegates protocol lifecycle and transports to the official MCP SDK, while
adding target descriptors, idempotent connection lifecycle, complete inventory
pagination, typed capability facades, explicit reconnect/cancellation, and
secret-redacted phase diagnostics.

Pass `handlers.roots`, `handlers.sampling`, or `handlers.elicitation` to infer
and advertise the corresponding client capabilities without raw SDK setup.
`onEvent()` and the `events` option observe redacted logging, progress, task
status, resource/list changes, subscriptions, and client-mediated requests.
The lower-level `configure` hook remains available for extensions.

```ts
import { createMcpFnClient, streamableHttpTarget } from "@mcpfn/client";

const client = createMcpFnClient({
  target: streamableHttpTarget("https://api.example.com/mcp"),
  diagnostics: (event) => audit.safe(event),
});

await client.connect();
const tools = await client.tools.listAll();
const boundedTools = await client.tools.listBounded(500);
const result = await client.tools.call("orders_list", { limit: 20 });
await client.close();
```

`listBounded()` variants retain at most the requested number of inventory
entries while pagination continues, returning `droppedItems` and `complete`
metadata without accumulating discarded pages in memory.

## Entry points

The main entry, `@mcpfn/client`, is remote-only: it never loads the SDK stdio
transport, `cross-spawn`, `node:child_process` or other Node.js built-ins.
A Cloudflare Worker can bundle it without the `nodejs_compat` flag and connect
to a remote server with `streamableHttpTarget()`. On Workers, and on other hosts
that forbid runtime code generation, tool output schemas are validated with the
official SDK's `@cfworker/json-schema` validator instead of Ajv; an explicit
`clientOptions.jsonSchemaValidator` takes precedence. Like the SDK's Ajv default
on Node.js, it applies keywords beside a `$ref` and draft-07 tuple `items`; it
also enforces later-draft keywords such as `prefixItems` and
`unevaluatedProperties`, which the draft-07 Ajv ignores.

Stdio targets spawn a child process and are Node.js-only. Import them from the
`@mcpfn/client/stdio` subpath:

```ts
import { createMcpFnClient } from "@mcpfn/client";
import { stdioTarget } from "@mcpfn/client/stdio";

const client = createMcpFnClient({
  target: stdioTarget({ command: "node", args: ["./server.js"] }),
});
```

`stdioTarget` exported from the main entry is deprecated and is removed in
0.2.0. Until then it remains as a compatibility path: on Node.js it loads
`@mcpfn/client/stdio` when the target opens. In runtimes without the `node`
export condition, such as Workers, opening it fails with
`MCPFN_TARGET_OPEN_FAILED`. See `CHANGELOG.md`.

## Authorization

`streamableHttpTarget()` uses Web Standard requests through the official SDK. Authorization is supplied through an
official `OAuthClientProvider`, including the McpFn provider from
`@mcpfn/auth`. When an interactive flow is required, `connect()` reports
`MCPFN_AUTHORIZATION_REQUIRED`; pass the callback code to
`completeAuthorization({ code, state })` and the client validates callback
correlation, completes the SDK exchange, and reconnects without replaying a
domain operation.

McpFn retries only connection establishment when explicitly configured. It
never implicitly replays tool calls, writes, or other capability operations.
