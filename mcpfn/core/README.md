# McpFn Core

`defineMcpFnServer()` creates a side-effect-free declaration whose registry and
manifest are shared by runtime, tests, and release tooling. Call
`declaration.createServer()` once per transport connection. Existing
`createMcpFnServer()` usage remains supported.

Declare protocol capabilities on `defineMcpFnServer()`. Per-connection runtime
options provide context, visibility, task storage, and transport behavior but
cannot add capabilities, so `declaration.manifest()` and every runtime manifest
remain byte-for-byte identical. When combining a supplied registry with inline
definitions, the declaration clones the registry before adding them.

`@mcpfn/core` is the shared MCP runtime for Superfunctions. It delegates wire protocol and transport behavior to the official Model Context Protocol SDK while providing the pieces product code needs to remain stable:

- an explicit, validated tool, resource, template, and prompt registry;
- authenticated, versioned client-profile catalog projection and trusted enrichment;
- actionable, value-free JSON Schema diagnostics;
- pagination, completions, subscriptions, and task-capable tools;
- server-initiated roots, sampling, elicitation, logging, and list-change notifications;
- MCP Apps resource and tool-link contracts;
- consistent structured and text results;
- deterministic, hashed manifests;
- breaking, additive, and model-behavior compatibility classification;
- stdio, Web Standard Streamable HTTP, and in-memory transport support through the official SDK.

```ts
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
} from "@mcpfn/core";

const registry = new McpFnRegistry()
  .register({
    name: "greet",
    description: "Greet one person by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ name }) =>
      structuredResult({ greeting: `Hello, ${String(name)}!` }),
  });

const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry,
  transports: ["stdio", "streamable-http"],
});

await server.serveStdio();
```

Tool definitions are public contracts. Do not derive tool names, descriptions, or exposed fields from storage schemas without an explicit exposure manifest.

## Server context and errors

Build trusted context once at the server boundary:

```ts
const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry: new McpFnRegistry<{ workspaceId: string }>(),
  context: async (extra) => ({
    workspaceId: await authenticateRequest(extra.requestInfo),
  }),
});
```

For tenant- or actor-specific discovery, use `toolVisibility`. McpFn applies
the hook to both `tools/list` and `tools/call`; a hidden call returns the same
protocol `MethodNotFound` response as an unknown tool. The static manifest
continues to describe the complete server contract.

```ts
const server = createMcpFnServer({
  info: { name: "admin", version: "1.0.0" },
  registry,
  context: (extra) => resolvePrincipal(extra.authInfo),
  toolVisibility: ({ tool, context }) =>
    context.permissions.includes(String(tool._meta?.permission)),
});
```

Do not accept workspace, tenant, actor, or credential identifiers as tool arguments. The context factory receives the official SDK request metadata and runs before every tool call.

Invalid input returns `MCPFN_INVALID_ARGUMENTS`; invalid declared output returns
`MCPFN_INVALID_OUTPUT`; other handler failures return `MCPFN_TOOL_ERROR`.
Error objects that already expose a string `code` keep it. Schema issues retain
`instancePath`, `schemaPath`, `keyword`, and safe keyword-specific names
such as `rejectedProperty` and `missingProperty`; rejected values are never
included. `handleInvalidArguments` is available for existing domain packages
that must map schema failures into a stable legacy envelope.

When a tool declares a success `outputSchema`, error details remain in its JSON text content and `structuredContent` is omitted so the official SDK does not validate an error envelope against the success schema. Tools without an output schema retain both structured and text error envelopes.

One `McpFnServer` instance connects to one transport. Create a new instance per concurrent connection and share the registry.

## Authenticated client profiles

Use `clientProfiles` only when an authenticated client needs a projected
catalog and server-owned required arguments. Profile matching receives a
`McpFnVerifiedClientIdentity` produced from trusted context; reported client
name/version and capabilities are available to hooks separately and cannot
select the profile.

```ts
const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry,
  context: (extra) => authenticateRequest(extra.authInfo),
  clientProfiles: {
    resolveVerifiedIdentity: ({ context }) => ({
      subject: context.authenticatedClientId,
    }),
    profiles: [{
      id: "consumer/trusted",
      version: "1",
      matches: ({ subject }) => subject === "trusted-client-id",
      serverOwnedArguments: { lookup: ["workspaceId"] },
      projectCatalog: ({ tools }) => tools.map((tool) => {
        if (tool.name !== "lookup") return tool;
        const { workspaceId: _hidden, ...properties } =
          tool.inputSchema.properties ?? {};
        return {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties,
            required: tool.inputSchema.required?.filter(
              (name) => name !== "workspaceId",
            ),
          },
        };
      }),
      enrichArguments: ({ arguments: args, context }) => ({
        ...args,
        workspaceId: context.workspaceId,
      }),
    }],
  },
});
```

McpFn applies canonical visibility before projection, checks calls against the
same effective catalog, rejects model-supplied server-owned fields, enriches
from trusted context, and only then invokes canonical Ajv validation. Declared
server-owned fields must be canonical required properties, must be absent from
the projected schema, and must be supplied by the enricher. A profile cannot
invent or duplicate tools or mutate model-owned arguments. No matching profile
preserves canonical behavior.

The optional `evidence` sink receives only bounded structural lifecycle
events. It is observational: a sink failure cannot fail or change a request.

## Resources, prompts, and client features

Use `registerResource`, `registerResourceTemplate`, and `registerPrompt` on the same registry. Resource-template and prompt completers advertise the completions capability automatically. Resource subscription handlers advertise `resources.subscribe`. List calls use stable `mcpfn:<offset>` cursors and a configurable server page size.

Task support is declared with `execution.taskSupport` and a `taskHandler`; a task-capable server must receive an official SDK `TaskStore`. `server.listRoots()`, `server.sample()`, and `server.elicit()` invoke matching client capabilities. Declare required client features in `clientRequirements` so manifests and host-profile tests can reject incompatible hosts before deployment.

HTTP servers with a `taskStore` must configure a cryptographically secure `sessionIdGenerator`. McpFn rejects stateless HTTP task storage before creating a handler: requests without a session ID share the store's unscoped task namespace, allowing another caller to list or retrieve task results. For example, pass `{ sessionIdGenerator: () => crypto.randomUUID() }` to `createWebStandardHandler`. The store must enforce the SDK's session-scoping contract. Authenticated sessions bind the verified `authInfo.clientId` plus `authInfo.extra.subject`, optional verified `issuer`, `tenantId`, and `regionId` at initialization. Later GET, POST, and DELETE requests must carry the same identity; a mismatch or missing authentication receives 404 before reaching the transport. Token and scope changes do not change ownership, so refresh remains compatible. Authenticated stateful initialization requires a nonempty stable string `authInfo.extra.subject` and otherwise returns 403 without a session. OAuth `clientId` alone identifies an application shared by many users and is not an ownership fallback. Verifiers must derive subject and tenant claims from verified credentials and authenticate initialization as well as subsequent requests; machine identities should provide a stable service-principal subject too. Migration: stateful hosts whose verifier previously omitted subject must supply it; do not omit `authInfo` to bypass identity validation. `clientId` must be a nonempty string; optional tenant/region values must be strings when present (omit missing values rather than supplying null). Optional issuer must be a nonblank string. Verifiers accepting multiple issuers must supply their verified issuer in `extra.issuer` or namespace the subject by issuer; never copy an unverified request claim. Sessions initialized anonymously accept only anonymous requests; adding authentication requires a new session. A session ID alone is not an authentication boundary.

`createWebStandardHandler()` accepts the official SDK `HandleRequestOptions`, including validated `authInfo`. Use `@mcpfn/auth` to publish OAuth protected-resource metadata and produce that trusted value. In stateless mode, McpFn creates and disposes an isolated SDK server and transport for every request. Attach protocol instrumentation with `configureRequestServer`; it receives the live isolated server before transport connection and runs once per request, or once per session initialization attempt. Because configuration precedes SDK request validation, a rejected attempt can invoke the hook without retaining a session. Supply a cryptographically secure `sessionIdGenerator` when the server uses sampling, elicitation, or another server-to-client request that must be correlated across HTTP requests; session-enabled handlers retain their transport across the session.

Stateful HTTP handlers default to `maxSessions: 1024` and `idleTimeoutMs: 1800000` (30 minutes). Both options must be positive integers; `maxSessions` must be a safe integer and `idleTimeoutMs` must not exceed 2147483647 milliseconds. The capacity applies per handler and includes pending initialization/configuration attempts; excess attempts receive HTTP 503. Capacity is reserved before asynchronous configuration, and failed initialization releases it. Keep configuration hooks bounded: a pending hook retains its reservation until it finishes or the parent server closes.

Idle expiry starts when all requests finish processing and all streaming response bodies finish or are cancelled. An open SSE response or active request keeps its session alive; the capacity limit still bounds retained sessions. Background tasks without an active HTTP request/response do not suspend expiry, so clients must poll within the idle timeout. Hosts must cancel response bodies when downstream clients disconnect. Expired sessions receive HTTP 404 and must initialize again. `server.close()` clears session timers and prevents pending initialization from retaining a late session.

Custom session ID generators must produce cryptographically secure IDs and **never reuse an ID**, including after a session expires or closes and across the lifetime of any durable task store. McpFn rejects live collisions before invoking the initialization callback, but does not retain an unbounded history of retired IDs. Reusing a retired ID can reconnect unrelated stored task data; idle expiry does not delete task-store history.

## Cloudflare Workers and edge runtimes

`@mcpfn/core` is a self-contained bundle: the official MCP SDK and a single
pinned Zod runtime are inlined into `dist`. Bundle it into a Cloudflare Worker
next to your application's own root `zod` dependency without adding a bundler
alias for `zod`/`zod/v4`, an import condition override, or any other
application-local shim. Enable Cloudflare's `nodejs_compat` compatibility flag,
which provides Node built-ins such as `node:crypto` used by the official MCP
SDK, and serve MCP through `createWebStandardHandler()`. Schema validation uses
Ajv draft-07 on Node and `@cfworker/json-schema` with the same dialect on
Cloudflare Workers and other runtimes that forbid runtime code generation. See
[ADR-0001](https://github.com/21nCo/super-functions/blob/main/mcpfn/ADR-0001-COMPATIBILITY.md)
for the compatibility policy.

See the [architecture](https://github.com/21nCo/super-functions/blob/main/mcpfn/ARCHITECTURE.md), [testing guide](https://github.com/21nCo/super-functions/blob/main/mcpfn/TESTING.md), and runnable [calculator example](https://github.com/21nCo/super-functions/blob/main/mcpfn/examples/calculator-server.ts).

Profile hooks that consume initialization metadata require a sessionful HTTP
handler (`sessionIdGenerator`). Stateless handlers accept only profiles explicitly
marked `requiresReportedClient: false`; their hooks must depend solely on verified
identity and request context. Model-owned property schemas retain their canonical
types and constraints. Projection may hide server-owned required fields, but does
not replace the canonical validator.

Projected input schemas may use static references within the document or an
embedded `$id` resource. Named draft-07 `$id` fragments and modern anchors are
aliases in their containing resource, so `#` and `#/...` still address that
resource's root. Dynamic, recursive, and unresolved external references fail
closed during catalog validation. Server-owned fields may only be hidden where
the root object contract can be compared without conditional or whole-object
ownership-sensitive constraints.
Draft-07 `$ref` siblings evaluated by the registry's Ajv, including `$id`
resource scope, are rejected during catalog validation because draft-07 clients
can ignore them while the runtime validator evaluates them.
The MCP-required root `type: "object"` is permitted; place other assertions on
the referenced target. Later-draft keywords and unknown extensions ignored by
the registry's draft-07 Ajv may remain beside `$ref`.

Structural diagnostics retain exact unknown property names and instance paths;
consumer report sinks must apply an aggregate size cap (the testing suite defaults
to one MiB) rather than silently shortening property names.

Task profile evidence distinguishes the creation handler from result persistence.
`handler` reports the creation callback's outcome; `task-result-storage: failed`
reports the first observed persistence failure for that request, including delayed
writes after creation returns. Retries do not repeat that failure event. It does
not reverse handler success or claim a final task status. Output validation still
runs for each attempted result before persistence.

Lifecycle evidence retains only recognized framework error codes; application-defined codes become `MCPFN_TOOL_ERROR`. Protocol error responses preserve the original application code and details.

## Supported Node runtimes

Core supports Node 18.18 and later. The SDK's web-standard HTTP transport requires
`globalThis.crypto.randomUUID`; on Node 18 enable global WebCrypto before starting
HTTP handlers, for example `NODE_OPTIONS=--experimental-global-webcrypto node app.mjs`.
Node 20 provides this global by default. This prerequisite also applies to the
previous SDK version; schema validation and in-memory transport do not require it.
`@superfunctions/admin` requires Node 20 or later.

After building core and shared admin, run
`node mcpfn/core/scripts/packed-runtime-acceptance.mjs` from the repository root to
pack both packages, install them in a disposable consumer, audit production
dependencies, and exercise ESM/CJS validation and MCP transport. Set `NODE18` and
`NODE20` to additional runtime executables. Set the WebCrypto `NODE_OPTIONS` flag
when testing Node 18 HTTP. The consumer directory is removed afterward.
