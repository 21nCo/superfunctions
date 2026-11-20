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

## Tools from an OpenAPI document

`fromOpenAPI()` from `@mcpfn/core/openapi` turns the operations of a parsed
OpenAPI 3.0 or 3.1 document into tools on an `McpFnRegistry`. Parse YAML
yourself; the function takes the document object. Calls go to the executor you
pass; each handler forwards the arguments the registry validated, unchanged.

```ts
import { fromOpenAPI } from "@mcpfn/core/openapi";

const { registry, tools, skipped } = fromOpenAPI(document, {
  executor: { execute: ({ operation, args, signal }) => send(operation, args, signal) },
  include: ["listPets", "tag:stores", "GET /health"],
  exclude: ["tag:internal"],
  prefix: "petstore.",
});
for (const { operation, code, reason } of skipped) {
  console.warn(`${operation.method ?? "*"} ${operation.path}: ${code} (${reason})`);
}
```

- **Exposure.** Only `GET` and `HEAD` are exposed by default. Any other method
  needs its operationId in `include` or `allowMutations: true`; a `tag:` or
  `METHOD /path` selector selects an operation but does not opt a mutation in.
  When `include` is given, nothing outside it is exposed, and `exclude` always
  wins. Deprecated operations need `includeDeprecated: true`.
- **Names.** The operationId, with `prefix` prepended, characters outside
  `[A-Za-z0-9_.-]` replaced by `_`, and truncated to 128 characters. Without an
  operationId the name is `<method>_<path segments>`, such as
  `get_users_userId_posts`. Collisions, including with tools already on a
  supplied registry, get `_2`, `_3`, ... in document order. A `name(operation)`
  callback replaces this; an invalid or duplicate result throws an error naming
  the operation before anything is registered.
- **Inputs.** The input schema is `{ path, query, header, body }`, each group
  present only when the operation has such inputs, with
  `additionalProperties: false` throughout. Referenced component schemas are
  copied under `definitions` (draft-07). `readOnly` properties are removed from
  inputs, and `Authorization`, `Cookie`, `Host`, `Content-Length`, `Proxy-*`,
  `Accept` and `Content-Type` headers are never inputs: credentials and
  transport headers belong to the executor.
- **Outputs.** The output schema is the schema of the first 2xx response with
  `application/json` content when it is a plain object schema (`writeOnly`
  properties removed); otherwise the tool declares none.
- **Annotations and description.** `GET`/`HEAD` are `readOnlyHint`, `DELETE`
  is `destructiveHint`, `PUT`/`DELETE` are `idempotentHint`, and every tool is
  `openWorldHint`. The description is the trimmed summary and description,
  joined by a blank line and capped at 2,000 characters.
- **Supported forms.** Local `#/components/{schemas,parameters,requestBodies,responses}/<name>`
  references (recursive schemas included); path- and operation-level parameters
  in `path`, `query` and `header` with their default styles over primitives and
  arrays of primitives; `application/json` and `*+json` bodies; OpenAPI 3.0
  `nullable`. Anything else is listed in `skipped` with a code and reason:
  external or URL references, `cookie` parameters, non-default styles,
  object-valued parameters, bodies without a JSON media type, and the 2020-12
  keywords `prefixItems`, `$dynamicRef`, `unevaluatedProperties`,
  `unevaluatedItems` and `dependentSchemas`. A Swagger 2.0 document throws.

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

Task support is declared with `execution.taskSupport` and a `taskHandler`; a task-capable server must receive an official SDK `TaskStore`. `server.listRoots()`, `server.sample()`, and `server.elicit()` invoke matching client capabilities over a transport connected with `server.connect()`. Behind `createWebStandardHandler()`, each request or session is served by its own isolated server, so tool handlers call `server.listRootsForRequest(extra)`, `server.sampleForRequest(extra, ...)` and `server.elicitForRequest(extra, ...)` with the handler's `extra`; the plain methods throw `MCPFN_CLIENT_REQUEST_NEEDS_REQUEST` there. Server notifications never leak one client's data to other sessions: `sendLoggingMessage(params)` reaches only the transport connected with `server.connect()`, and `sendLoggingMessage(params, sessionId)` reaches only the client with that session id (tool handlers pass `extra.sessionId`; stateless handlers log through `extra.sendNotification`). `sendResourceUpdated()` reaches the directly connected transport and only those `createWebStandardHandler()` sessions that hold a successful `resources/subscribe` for that exact URI, until they unsubscribe or the session closes (an unsubscribe also cancels a subscribe for that URI that is still running). `sendToolListChanged()`, `sendResourceListChanged()` and `sendPromptListChanged()` carry no data and reach every connected client. Declare required client features in `clientRequirements` so manifests and host-profile tests can reject incompatible hosts before deployment.

`createWebStandardHandler()` accepts the official SDK `HandleRequestOptions`, including validated `authInfo`. Use `@mcpfn/auth` to publish OAuth protected-resource metadata and produce that trusted value. In stateless mode, McpFn creates and disposes an isolated SDK server and transport for every request. Attach protocol instrumentation with `configureRequestServer`; it receives the live isolated server before transport connection and runs once per request, or once per session initialization attempt. Because configuration precedes SDK request validation, a rejected attempt can invoke the hook without retaining a session. Supply a cryptographically secure `sessionIdGenerator` when the server uses sampling, elicitation, or another server-to-client request that must be correlated across HTTP requests; session-enabled handlers retain their transport across the session.

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

Structural diagnostics are bounded: a result carries at most 100 issues;
property names, keywords and messages are cut to 256 characters; and instance or
schema paths longer than 256 characters are reported as the root (`/`, `#`).
Any issue shortened this way has `truncated: true`, so consumers can tell an
exact name or path from a bounded one. Report sinks that aggregate many issues
should still apply their own size cap.

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
