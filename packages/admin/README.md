# `@superfunctions/admin`

Shared, function-owned administration contracts for Super Console and self-hosted API consumers.

The package keeps one operation definition authoritative across the operator UI, REST/OpenAPI, the TypeScript client, and McpFn. A function exports a capability manifest and binds its domain administration service through `createAdminCapabilityAdapter`. The console explicitly enables modules through `createAdminRegistry`; an empty allowlist produces a shell-only installation, and disabled functions expose no route, OpenAPI operation, navigation entry, or MCP tool.

```ts
import {
  createAdminCapabilityAdapter,
  createAdminDispatcher,
  createAdminOpenApiDocument,
  createAdminRegistry,
  createAdminClient,
  defineAdminCapability,
  MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore,
} from "@superfunctions/admin";

const manifest = defineAdminCapability({
  schemaVersion: "1.0",
  id: "examplefn",
  displayName: "ExampleFn",
  version: "1.0.0",
  description: "Operate ExampleFn.",
  category: "example",
  availability: "optional-product",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  operations: [{
    id: "examplefn.records.list",
    title: "List records",
    description: "List records in the active scope.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "object" } } },
      required: ["items"],
    },
    route: { method: "GET", path: "/resources/records" },
    permission: "examplefn.records.read",
    safety: { classification: "read", idempotent: true, audit: "optional" },
    target: { resource: "records", collection: true },
    pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 200 },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }],
});

const adapter = createAdminCapabilityAdapter(manifest, {
  "examplefn.records.list": async ({ context }) => ({
    ok: true,
    data: { items: [] },
    meta: { environmentId: context.scope.environmentId },
  }),
});

const registry = createAdminRegistry({
  adapters: [adapter],
  enabledModules: ["examplefn"], // always explicit
});

const dispatcher = createAdminDispatcher({
  registry,
  audit: new MemoryAdminAuditSink(),
  idempotency: new MemoryAdminIdempotencyStore(),
});

const openapi = createAdminOpenApiDocument(registry);

const client = createAdminClient({ baseUrl: "https://console.example.com/api/admin/v1" });
const enabled = await client.registry();
const overview = await client.overview();
const search = await client.search("failed deploy", { limit: 25 });
const auditPage = await client.audit({ module: "cifn", outcome: "failed" });
const settings = await client.settings();
const mcpMetadata = await client.mcp();
const confirmation = await client.issueConfirmation("examplefn.records.delete", { id: "record_1" });
await client.invokeOperation("examplefn.records.delete", { id: "record_1" }, {
  idempotencyKey: crypto.randomUUID(),
  confirmationToken: confirmation.token,
});
```

Production deployments inject AuthFn-backed actor/context resolution, an append-only audit sink (typically observed by WatchFn), durable atomic idempotency storage, confirmation verification, and function-owned services. `Memory*` implementations are intended for tests and embedded development only: the memory idempotency store prevents concurrent execution inside one process but is neither durable nor multi-process safe. A production store must atomically reserve the full identity, fence completion and pre-domain release with the claim token, and define stale-claim recovery. Claims are released only when the domain handler was never entered; post-domain errors remain fenced because the commit outcome may be uncertain.

Required-audit mutations append a sanitized `attempted` event before the
function handler runs, then a terminal outcome. A rejected attempt write fails
before domain mutation. Audit and domain storage are not one transaction, so
production operations must monitor and reconcile attempted events without a
terminal record.

## Safety invariants

- All four tenant IDs are required in invocation context; namespace and region remain subordinate execution attributes.
- Mutations must declare required audit; destructive operations must require confirmation.
- Destructive operations declare an exact `target.resource` and required `target.idInput`; collection actions declare `target.collection` so consoles never render an unbound target mutation.
- `redaction.inputFields` protects audit input and `redaction.outputFields` scrubs validated domain output before the first response or idempotency storage/replay.
- Idempotency identities bind key, actor, full tenant scope, and operation. Atomic begin/complete claims prevent concurrent execution; reusing a key with different input is rejected.
- Registry dependency, cycle, operation, route-pattern, and MCP-name collisions fail closed.
- Generic validation/errors/audit records never echo raw secrets; audit input recursively redacts common secret keys.
- MCP tools invoke the shared dispatcher and therefore cannot bypass policy, confirmation, idempotency, validation, or audit.

McpFn mutation tools add a reserved `_admin` object to their projected input schema. Idempotent writes require `_admin.idempotencyKey`; destructive operations additionally require `_admin.confirmationToken`. The projection strips `_admin` before validating or invoking the function-owned domain handler, so REST/OpenAPI domain schemas remain unchanged and mutation controls cannot be persisted accidentally.
