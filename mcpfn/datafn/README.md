# McpFn DataFn Adapter

`@mcpfn/datafn` turns explicitly approved DataFn operations into stable MCP tools. It is deny-by-default:

- no resource is exposed unless named in `expose`;
- every read uses a fixed output projection;
- filters and sort fields are allowlisted;
- writes require explicit writable fields and a caller-supplied idempotency key;
- principal and namespace context comes from the server, never tool arguments;
- all calls execute through `DatafnExecutor`, preserving DataFn validation, permissions, hooks, authorization, namespace isolation, rate limits, and idempotency.

```ts
import { createMcpFnServer } from "@mcpfn/core";
import { createDatafnMcpRegistry } from "@mcpfn/datafn";

const registry = createDatafnMcpRegistry({
  schema,
  executor: datafnServer.executor,
  context: (mcpContext) => ({
    workspaceId: mcpContext.workspaceId,
    actorId: mcpContext.actorId,
  }),
  clientId: (mcpContext) => `mcp:${mcpContext.credentialId}`,
  expose: {
    skills: {
      fields: ["id", "slug", "name", "updatedAt"],
      list: {
        filterFields: ["slug", "name"],
        sortFields: ["updatedAt", "id"],
        maxLimit: 50,
      },
      get: true,
    },
  },
});

const server = createMcpFnServer({
  info: { name: "skills-data", version: "1.0.0" },
  registry,
  context: async (extra) => authenticateMcpRequest(extra.requestInfo),
  transports: ["stdio", "streamable-http"],
});
```

Mutation tools need the function form of `clientId`, returning a value per
credential: DataFn keys idempotency records by namespace, client ID and the
model-supplied `mutationId`, so with one fixed string two users could share
records. A fixed string is accepted for read-only exposure, or with
`allowSharedClientId: true`. List filters accept scalar values only; `object`
and `array` fields are left out of the default filters and refused in an
explicit `filterFields`.

## Install

`@datafn/server` is a peer dependency: install a version in `>=0.1.1 <0.3.0`
beside `@mcpfn/datafn`.

## Scope-aware tools

Give `sessionScopes` to gate tools by the scopes the session was granted, and
declare on each exposed resource the scopes its read tools (list, get) and
write tools (create, update, delete) need. The host supplies both: the adapter
takes scope strings from your own authentication and never imports AuthFn. A
needed `<owner>:<action>` scope is granted by the same string, by `<owner>:*`
or by `*`.

```ts
import { createMcpFnServer, structuredResult } from "@mcpfn/core";
import { createDatafnMcpAdapter } from "@mcpfn/datafn";

const adapter = createDatafnMcpAdapter({
  executor: datafnServer.executor,
  context: (session) => ({ actorId: session.actorId }),
  clientId: (session) => `mcp:${session.credentialId}`,
  sessionScopes: (session) => session.scopes,
  expose: {
    notes: {
      fields: ["id", "title", "updatedAt"],
      scopes: { read: ["memotron:read"], write: ["memotron:write"] },
      create: { fields: ["title"] },
      update: { fields: ["title"] },
    },
  },
});

// Domain tools sit beside the generated ones; `scopes` gates them the same way.
adapter.registerTool({
  name: "memotron_summarize",
  description: "Summarize the session's notes.",
  inputSchema: { type: "object" },
  handler: async (_args, session) => structuredResult(await summarize(session)),
}, { scopes: ["memotron:read"] });

const server = createMcpFnServer({
  info: { name: "memotron", version: "1.0.0" },
  registry: adapter.registry,
  toolVisibility: adapter.toolVisibility,
  context: async (extra) => authenticateMcpRequest(extra),
});
```

- `tools/list` omits a gated tool the session's scopes do not allow.
- A call to such a tool, listed or not, returns a tool error with code
  `insufficient_scope` and `details: { requiredScopes, missingScopes }` before
  any DataFn operation runs, and before an invalid-arguments error, with two
  exceptions McpFn decides before any tool code: a call over McpFn's argument
  size limit (100,000 values) is refused as invalid arguments, and with
  `clientProfiles` a failed argument enrichment answers first. Unknown tool
  names keep McpFn's usual error.
- The denial is thrown as a plain `{ code, message, details }` object
  (`DatafnInsufficientScopeError`), not an `McpFnError`, so it keeps its code
  and scope lists even when the adapter and the server load different copies
  of `@mcpfn/core` (one ESM, one CommonJS). A direct `registry.callTool`
  caller receives that object as the rejection.
- The session's scopes are resolved once per `tools/list` and afresh for every
  call.
- A tool with `scopes` cannot support task execution: registering one with a
  `taskHandler` or a `taskSupport` other than `"forbidden"` fails, and a
  task-augmented call to a gated tool gets McpFn's "does not support task
  augmentation" error. Ungated host tools keep task support.
- The handlers check scopes even without the visibility hook, so a server that
  omits `toolVisibility` (or uses `createDatafnMcpRegistry`) still refuses the
  calls but lists every tool.
- Tools the adapter does not gate, including host tools registered without
  `scopes` or already in a supplied `registry`, are always visible to its hook;
  combine it with your own hook as
  `toolVisibility: async (input) => (await adapter.toolVisibility(input)) && mine(input)`.
- With `sessionScopes`, every enabled operation needs a non-empty, unique list
  of concrete `<owner>:<action>` scopes, each part lowercase letters, digits,
  `_`, `.` or `-` (no `*` or `<owner>:*`); without it, declaring scopes fails.
  A resolver result that is not an array grants nothing.

This adapter is appropriate for bounded data operations. Domain workflows with additional authorization, auditing, asset grants, or version-resolution semantics should remain explicit McpFn tools.

## Exposure reference

- `fields` is the fixed list/get projection and must be non-empty, unique, and allowed by DataFn read policy.
- `list` and `get` default to enabled after the resource itself is explicitly present in `expose`; pass `false` to disable either one.
- `list.filterFields` defaults to `fields`; `sortFields` defaults to `id`; `defaultLimit` defaults to `50`; `maxLimit` defaults to `100`.
- `create`, `update`, and `delete` default off. Create/update require a writable `fields` allowlist. All writes require `mutationId` and use the trusted `clientId` resolver.
- Default names are `datafn_<resource>_<operation>`; `toolPrefix`, per-operation `name`, and descriptions can be overridden.
- `scopes.read` covers list and get; `scopes.write` covers create, update and delete.

Adapter construction fails before serving if a resource or field is unknown, unreadable, read-only, or not writable under the resolved DataFn capabilities.
