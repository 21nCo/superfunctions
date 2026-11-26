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
  `{ operationId: "<id>" }` selects an operationId exactly, for one that reads
  as a tag or route selector (such as `{ operationId: "tag:pets" }`), and
  opts it in like a plain operationId.
  When `include` is given, nothing outside it is exposed, and `exclude` always
  wins. Deprecated operations need `includeDeprecated: true`.
- **Names.** The operationId, with `prefix` prepended, characters outside
  `[A-Za-z0-9_.-]` replaced by `_`, and truncated to 128 characters. Without an
  operationId the name is `<method>_<path segments>`, such as
  `get_users_userId_posts`. Collisions, including with tools already on a
  supplied registry, get `_2`, `_3`, ... in document order; an operation
  skipped at registration does not take a name. A `name(operation)`
  callback replaces this; an invalid or duplicate result throws an error naming
  the operation before anything is registered.
- **Inputs.** The input schema is `{ path, query, header, body }`, each group
  present only when the operation has such inputs. The wrapper and the
  `path`, `query` and `header` groups have `additionalProperties: false`;
  `body` follows its own schema. Referenced component schemas are copied
  under `definitions` (draft-07). `readOnly` properties (flagged on the
  property, on a schema it references, on an `allOf` member, or on every
  non-null alternative of an `anyOf`/`oneOf` such as
  `anyOf: [{ $ref }, { type: "null" }]`) are left out of inputs where they are
  declared: the property becomes `false` (or is dropped from an object closed
  by `additionalProperties: false`) and leaves that object's `required`, so
  the name is refused whatever `patternProperties` or `additionalProperties`
  say. This is done only along a plain chain from the body: `properties`, one
  `items` schema, a schema-valued `additionalProperties`, `allOf`, `$ref`, and
  `anyOf`/`oneOf` members that accept different kinds of value (an object
  and `null`, an object and an array). The operation is skipped
  (`unsupported-access-flag`) when a flagged property sits under alternatives
  that can accept the same kind of value, `not`, `if`/`then`/`else`, a
  dependency, `patternProperties`, `contains`, tuple `items`,
  `additionalItems` or `propertyNames`; when another schema for the object
  requires the name or has `const`, `enum`, `minProperties` or a dependency;
  when a conditional schema for the object lists the name or has
  `maxProperties`, `patternProperties`, `propertyNames` or a closed
  `additionalProperties`; or when a child value holding flagged properties
  has more than one schema, sits under a condition, or is compared whole
  (`const`, `enum`, `uniqueItems`, `contains`). Patterns in the document are
  never evaluated for this. In OpenAPI 3.0 every `$ref` sibling is ignored, `readOnly`
  and unsupported keywords included; in 3.1 they apply. The request
  body is the first `application/json` media entry that is an object, else the
  first such `*+json` one; a declared body without a JSON media type is
  skipped (`non-json-body`), one whose JSON entries are not usable objects or
  that declares no content is skipped (`invalid-request-body`), and a media
  entry without `schema` accepts any JSON value. `Authorization`, `Cookie`,
  `Host`, `Content-Length`, `Proxy-*`, `Accept` and `Content-Type` headers are
  never inputs: credentials and transport headers belong to the executor.
- **Parameters.** A path, query or header parameter must accept either single
  primitive values or arrays of primitives, judged through `$ref`, `allOf`,
  `anyOf` and `oneOf`; `null` may accompany either. A parameter that can be an
  object (including a schema without `type`, `enum` or `const`, such as `{}`),
  an array of objects or arrays, or both an array and a single value is skipped.
- **Outputs.** The selected response schema is the first `application/json`
  entry with a `schema`, scanning 2xx responses in order. It is always
  converted, for `HEAD` too, so the skip rules apply to it whatever its
  shape or method; a schema that is discarded, or whose `writeOnly`
  properties are left out, is first compiled by mcpFn's validator as
  written. A `HEAD` tool never declares an output schema, since its response
  has no body. Otherwise the schema becomes the output schema when it
  accepts objects and nothing else (also through a 3.1 `$ref` with sibling
  keywords, an `allOf`, or a `not` of bare types such as
  `not: { type: "null" }`), with `writeOnly` properties left out by the same
  rule as `readOnly` ones in inputs; when that rule cannot be applied, the
  operation is skipped (`unsupported-access-flag`), so no tool returns
  structured content its schema did not check.
- **Paths.** `x-*` entries of the Paths Object are extensions and are ignored.
- **Annotations and description.** `GET`/`HEAD` are `readOnlyHint`, `DELETE`
  is `destructiveHint`, `PUT`/`DELETE` are `idempotentHint`, and every tool is
  `openWorldHint`. The description is the trimmed summary and description,
  joined by a blank line and capped at 2,000 characters.
- **Supported forms.** Local `#/components/{schemas,parameters,requestBodies,responses}/<name>`
  references (recursive schemas included when the recursion descends into a
  property or item); path- and operation-level parameters
  in `path`, `query` and `header` with their default styles over primitives and
  arrays of primitives; `application/json` and `*+json` bodies; OpenAPI 3.0
  `nullable`, which adds `null` to an explicit `type` only (an `enum` keeps
  excluding `null` unless it lists it). Anything else is listed in `skipped` with a code and reason:
  external or URL references, `cookie` parameters, a parameter named after
  a property every object inherits (`__proto__`, `toString`, `constructor`,
  ...) (`unsupported-parameter-name`), and a schema that declares, requires
  or lists in a dependency such a name, in a body or a response
  (`unsupported-property-name`), with no exception, under either engine: Ajv reads those names through the
  prototype (and leaves a `__proto__` key of `properties` out) while
  @cfworker/json-schema reads own properties only. Also skipped:
  non-default styles,
  object-valued or mixed parameters, bodies without a JSON media type, a
  `$ref` cycle that returns to the same value without descending into a
  property or item, and the 2019-09/2020-12 keywords `prefixItems`,
  `$dynamicRef`, `unevaluatedProperties`, `unevaluatedItems`,
  `dependentSchemas`, `minContains` and `maxContains` (`dependentRequired` is
  translated to draft-07 `dependencies`). A 3.1 `jsonSchemaDialect` or
  `$schema` other than a published OAS 3.1 base dialect id
  (`.../dialect/base`, `.../dialect/2024-10-25` or `.../dialect/2024-11-10`)
  or JSON Schema 2020-12,
  or any `$schema` in a 3.0 document, skips the schemas it governs
  (`unsupported-dialect`), boolean schemas included; a schema root that names
  a supported `$schema` itself is read in it, and a JSON body without
  `schema` declares none, so it accepts any JSON value in any dialect. A 3.1
  `dependencies` keyword is ignored, since 2020-12 defines none. One budget bounds all of one call's work: once
  its conversions and copies have produced 1,000,000 nodes plus 64 per value
  of the document, every schema converted after that is skipped
  (`schema-too-large`). Each tool schema copy (its root, literals included,
  and the component schemas it holds) is charged node by node as it is made,
  and so are a copy made to check a schema and each walk of a closure's
  references; a copy that fails is charged only for what it copied. Each
  tool's catalog entry copies its schemas again: that copy is charged in
  document order and given back when the tool does not register. A schema
  several tools share is compiled at its first reuse, and when the registry's
  validator rejects it, every tool holding it is skipped with that verdict
  and holds no catalog copy, so it never crowds out a later tool. No schema has a size or depth limit of its own: a schema that
  repeats objects the document shares between positions into more than four
  times the values they hold is skipped (`schema-too-large`), and a schema
  nested or referencing too deeply for the converter or the registry's
  validator to compile (a stack overflow) is skipped the same way. Under
  @cfworker/json-schema, which follows references only while validating, the
  frames one value stacks are read from the schema itself and compared with
  how deep the engine validates on the call's stack, measured once per call
  with the engine. At every position (parameters, bodies, properties and
  items) the subschemas and references applied in place count, each child
  value from its own first frame. Only the chain every valid tool input
  takes stacks on its parent's frames: from the input (or a registered
  output), a property a `required` list names, through `properties`, a matching
  `patternProperties` entry or else `additionalProperties`, when only
  objects are accepted (`number` also admits integers), every declared
  property of a closed object (`additionalProperties: false`, no
  `patternProperties`; with several, the names they all declare) whose
  `minProperties` is at least their number, less any name a member declares
  `false`, and
  the items up to `minItems` when only arrays are,
  read together from one schema object and its inline `allOf` members (for
  example `required` in one member and `properties` in another). A pattern
  is matched against required names only when it has no groups,
  alternation, backreferences or lookaround and at most one quantifier,
  with the matching charged; any other pattern forces nothing. A required
  name must be an own property (mcpFn requires @cfworker/json-schema
  `^4.1.6`, which reads own properties only). A child a
  call can leave out or avoid (an optional body or property, an
  `anyOf`/`oneOf` branch) never stacks, since a shallow valid input exists,
  and a chain of required children from the input that never ends, which
  no finite value satisfies, is too deep. This reading is charged to the same budget. Near
  the validator's own limit, that verdict is the validator's. A forced child
  whose `type`, `required` or `minItems` sits only behind a `$ref` is not
  read as forced, so such a tool can register; a call whose value then nests
  too deeply for the engine's stack is rejected by the registry like any
  other invalid arguments (`MCPFN_INVALID_ARGUMENTS`, keyword `depth`),
  never as a thrown `RangeError`. A schema compiled
  only to be checked (a `HEAD` or non-object response, or one with
  properties to leave out) is compiled once per distinct schema. A Swagger
  2.0 document throws.
- **Catalog.** `tools` holds copies of the registered schemas, so changing
  them changes neither what the registry lists nor what it validates. In a
  registry `fromOpenAPI` creates, tools with identical schemas register one
  deeply frozen object, compiled once; a supplied registry gets a fresh
  object per tool.
  `operation` is deeply frozen and typed read-only.
- **Servers.** `operation.servers` is the first non-empty `servers` list of
  the operation, path item and document, else `[{ url: "/" }]`.

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

In a tool result, only `McpFnError` (and its subclasses), the SDK's `McpError` (as code `MCPFN_TOOL_ERROR`, its JSON-RPC code not kept, with its message and its `data` as `details`) and a thrown plain `{ code, message }` object reach the client with their code, message and details. Resource, prompt, completion, subscription and other request handlers keep only `McpFnError` and `McpError`; a thrown plain object is withheld there too. Any other thrown value, such as a filesystem, database or upstream
HTTP error, becomes `{ code: "MCPFN_TOOL_ERROR", message: "The tool failed",
details: { errorId } }`; resource, prompt, completion and subscription handlers
answer such errors with a JSON-RPC `InternalError` carrying the same `errorId`.
This covers errors from context factories, visibility hooks and task creation
as well. The original error goes to the server's `onError({ error, errorId,
method, tool })` sink, which is not awaited. An `McpError` from another copy of the SDK (such as the application's own) is recognised by its `McpError` name and `MCP error <code>:` message; a renamed subclass of it is withheld, so throw `McpFnError` for domain errors that must reach the client. `exposeErrors: true` restores verbatim error text. Argument validation
stops at the first failure where the schema allows it: a large array whose
`items` fail stops at the first bad item, while a failing `anyOf` or `oneOf`
still reports each branch and, on `@cfworker/json-schema`, a tuple with
`additionalItems: false` reports each extra item (responses keep at most 100
issues), and tool arguments with more than 100,000 values in total are refused before any schema validation. Each client may hold at most `maxResourceSubscriptions` (default 1000) resource
subscriptions.

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
invent or duplicate tools or mutate model-owned arguments.

A client that matches no profile (no verified identity, or one no profile
accepts) sees the canonical catalog without the tools that any profile gives
server-owned arguments: it could never call them, since it may not supply
those arguments and they are required. Calling such a tool answers like an
unknown tool, so a client cannot pick a tenant or workspace by not matching a
profile. Set `unmatchedServerOwnedArguments: "allow"` to list those tools and
pass their arguments through unchanged, as before; the handler must then
derive the value from trusted context itself.

The optional `evidence` sink receives only bounded structural lifecycle
events. It is observational: a sink failure cannot fail or change a request.

## Resources, prompts, and client features

Use `registerResource`, `registerResourceTemplate`, and `registerPrompt` on the same registry. Resource-template and prompt completers advertise the completions capability automatically. Resource subscription handlers advertise `resources.subscribe`. List calls use stable `mcpfn:<offset>` cursors and a configurable server page size.

Task support is declared with `execution.taskSupport` and a `taskHandler`; a task-capable server must receive an official SDK `TaskStore`. `server.listRoots()`, `server.sample()`, and `server.elicit()` invoke matching client capabilities over a transport connected with `server.connect()`. Behind `createWebStandardHandler()`, each request or session is served by its own isolated server, so tool handlers call `server.listRootsForRequest(extra)`, `server.sampleForRequest(extra, ...)` and `server.elicitForRequest(extra, ...)` with the handler's `extra`; the plain methods throw `MCPFN_CLIENT_REQUEST_NEEDS_REQUEST` there. Server notifications never leak one client's data to other sessions: `sendLoggingMessage(params)` reaches only the transport connected with `server.connect()`, and `sendLoggingMessage(params, sessionId)` reaches only the client with that session id (tool handlers pass `extra.sessionId`; stateless handlers log through `extra.sendNotification`). `sendResourceUpdated()` reaches the directly connected transport and only those `createWebStandardHandler()` sessions that hold a successful `resources/subscribe` for that exact URI, until they unsubscribe or the session closes (an unsubscribe also cancels a subscribe for that URI that is still running). `sendToolListChanged()`, `sendResourceListChanged()` and `sendPromptListChanged()` carry no data and reach every connected client. Declare required client features in `clientRequirements` so manifests and host-profile tests can reject incompatible hosts before deployment.

`createWebStandardHandler()` accepts the official SDK `HandleRequestOptions`, including validated `authInfo`. Use `@mcpfn/auth` to publish OAuth protected-resource metadata and produce that trusted value. In stateless mode, McpFn creates and disposes an isolated SDK server and transport for every request. Attach protocol instrumentation with `configureRequestServer`; it receives the live isolated server before transport connection and runs once per request, or once per session initialization attempt. Because configuration precedes SDK request validation, a rejected attempt can invoke the hook without retaining a session. Supply a cryptographically secure `sessionIdGenerator` when the server uses sampling, elicitation, or another server-to-client request that must be correlated across HTTP requests; session-enabled handlers retain their transport across the session.

Each stateful handler defaults to 1,000 sessions (`maxSessions`) and 100 sessions per principal (`maxSessionsPerPrincipal`). Anonymous clients share one principal allowance. A request without a session ID reserves a slot during initialization, and closing sessions count until cleanup finishes. At capacity, requests for new sessions receive HTTP 429 for the principal limit or HTTP 503 for the handler limit. Clients can retry after a slot is freed.

An idle session expires after 30 minutes without a matching HTTP request that passes the configured Host and Origin checks (`sessionIdleTimeoutMs`), even if a response stream is open or a previous request is still pending. Initialization has the same time limit from admission until the HTTP response is ready. A stalled initialization receives HTTP 408. Expiry closes the isolated server and transport and calls `onsessionclosed`, when supplied. Subsequent requests receive HTTP 404 and must initialize a new session. Set any of the three options to a positive safe integer to adjust the defaults.

Use `onsessionclosed` to release host-managed session resources such as subscription registrations. Pending lifecycle hooks and event-store writes started during setup hold capacity until they finish and cleanup completes. Give hooks and event stores that rely on external services their own timeouts.

HTTP security defaults: a request carrying an `Origin` header is refused with
HTTP 403 unless `allowedOrigins` lists it or it is a loopback origin equal to the
request's `Host`; a browser may omit `Origin` on a same-origin GET, so local servers should also accept only their own `Host` names (`originPolicy: "off"` disables this; setting
`enableDnsRebindingProtection` hands Host and Origin checks to the SDK
transport). A session belongs to the principal that created it
(`sessionPrincipal`, by default the `authInfo.extra.subject` and client ID, with `extra.issuer` and `extra.tenantId` when the verifier reports them, or the token itself when the verifier sets no subject, so set `extra.subject` for sessions to outlive token refresh; a server that trusts more than one issuer must also set `extra.issuer`, since subjects from verifiers that leave it unset share one namespace); a request
from another principal, including GET and DELETE, gets the same 404 as an
unknown session. In sessionful mode a configured `eventStore` is scoped per
session, so `Last-Event-ID` resumption only replays the session's own events; a
stateless handler has no session to scope it to, so don't share an event store
between principals there.

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
