# MCP through McpFn

## Role of McpFn

McpFn is the protocol and conformance layer for agent administration. It is not a separate dashboard. Super Console projects eligible operations from the enabled registry into McpFn manifests and server handlers.

## Tool projection

Each eligible operation yields a deterministic namespaced tool:

```text
superconsole_<module>_<resource>_<action>
```

The tool description includes the domain purpose, required permission, safety level, idempotency behavior, and confirmation requirement. Input JSON schema is derived from the same capability schema used by REST/OpenAPI. The active scope travels in request context rather than being frozen into a reusable tool description.

Disabled modules, operations marked `mcp: false`, and tools the authenticated actor cannot invoke do not appear in that actor's discovery response. Discovery filtering is defense in depth; invocation re-evaluates authentication, scope, permission, policy, input, and confirmation.

The authenticated streamable HTTP endpoint is `/api/admin/v1/mcp/transport`. `/api/admin/v1/mcp` is operator metadata for the console, not the JSON-RPC transport.

## Invocation

McpFn authenticates the client or resolves a session-bound actor, constructs the canonical request context, and invokes the shared dispatcher. A tool cannot call a function adapter directly. Therefore MCP cannot bypass:

- AuthFn authentication;
- workspace/project/environment membership;
- namespace and region scope;
- operation and object-level authorization;
- schema validation;
- confirmation and idempotency;
- audit and observation emission;
- secret redaction.

## Mutations

Mutations are permitted because the user explicitly selected full API/MCP administration. They are controlled as follows:

- safety metadata is present in tool annotations and descriptions;
- sensitive and destructive tools require explicit confirmation input or host confirmation according to capability policy;
- idempotent mutations require or generate an exposed key the caller can safely reuse;
- irreversible bulk actions use narrow schemas and bounded selection rather than unscoped query strings;
- results include request and audit identifiers;
- raw secrets are accepted only by a schema designed for that secret and are never echoed.

For mutation tools, McpFn adds a reserved `_admin` object to the projected input. Idempotent writes require `_admin.idempotencyKey`; destructive writes also require `_admin.confirmationToken`. `_admin` is removed before domain schema validation and cannot reach the function service. The token is obtained with `superconsole_confirm_operation`, which runs the same authentication, scope, permission, policy, schema, and audit checks as REST confirmation issuance.

## Resources and prompts

The v1 projection exposes tools. Read-only MCP resources and guided prompts are possible future additions; they are not part of the implemented contract and would never grant permission or substitute for operation handlers.

## Naming and compatibility

Tool names remain stable within a capability major version. V1 has no deprecation fields; a future rename contract must add replacement and sunset metadata to manifests, discovery, OpenAPI, the SDK, MCP, and the UI together. The McpFn manifest records registry and function capability versions so clients can diff installations.

## Conformance

Verification covers:

- discovery contains only enabled modules and actor-permitted tools;
- tool schema and operation metadata match OpenAPI;
- AuthFn-backed request/session authentication at the McpFn transport;
- tenant and object-level policy denial;
- read and mutation results;
- confirmation, idempotency replay, and audit correlation;
- normalized and protocol-safe errors;
- secret redaction and bounded output.
