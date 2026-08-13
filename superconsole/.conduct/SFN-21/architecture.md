# Architecture

## Core invariant

One validated deployment registry projects the enabled system into five synchronized surfaces:

```text
function-owned admin services and manifests
                    │
                    ▼
        @superfunctions/admin registry
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
 SvelteKit UI   REST/OpenAPI   McpFn tools
                    │
                    ▼
           TypeScript admin SDK
```

The registry must make the following true by construction:

1. disabled modules are neither discoverable nor addressable;
2. every surface uses identical authentication, scope, policy, schema validation, domain execution, normalized error, idempotency, and audit behavior;
3. Super Console depends on transport-neutral function contracts, while functions do not depend on SvelteKit.

## Layers

### Function-owned domain administration

Every function's `admin` package declares:

- operator resources and identifiers;
- list, get, mutation, and domain-action service methods;
- JSON schemas for input and output;
- tenant scope and permissions;
- safety, confirmation, and idempotency metadata;
- audit action and target metadata;
- health and related-resource signals;
- an adapter factory that delegates to an injected domain service.

The package does not create fake product data or embed framework-specific handlers.

### Shared administration kernel

`@superfunctions/admin` supplies:

- manifest types and validation;
- dependency and nested-ownership resolution;
- the enabled-module registry;
- request and tenant context;
- authentication and authorization interfaces compatible with AuthFn;
- policy enforcement;
- schema validation;
- cursor pagination and normalized errors;
- idempotency coordination;
- domain dispatch;
- sanitized audit emission;
- OpenAPI 3.1 generation;
- McpFn-compatible tool projection and invocation;
- a fetch-based TypeScript administration client.

It is transport-neutral and has no Svelte dependency.

### Super Console composition server

The SvelteKit server:

- loads explicit server-only installation configuration;
- binds real function service adapters to manifests;
- creates the registry and shared dispatcher;
- resolves AuthFn actors and canonical tenant context;
- exposes versioned REST, OpenAPI, MCP, registry, audit, search, and settings endpoints;
- supplies view models to Svelte routes;
- fails startup on invalid dependencies, collisions, or unsafe capability declarations.

### UIFn presentation

Svelte routes consume view models and operation links from the registry. They do not import domain storage. Shared interaction patterns come from UIFn. Module presentation code may compose UIFn primitives but may not fork them.

## Registry validation

Startup validation rejects:

- duplicate module, operation, normalized route, OpenAPI operation, or MCP tool identifiers;
- dependency cycles or missing required modules;
- a nested module whose declared parent is absent;
- conflicting route patterns;
- mutations without permission and audit metadata;
- destructive operations without confirmation and an exact resource target;
- redaction metadata that is malformed or is used without auditing;
- MCP safety hints that contradict operation safety;
- invalid scope declarations;
- capability schema versions unsupported by the kernel.

Validation fails closed before the server accepts requests.

## Deployment registration

Modules are enabled by a typed server-only manifest. Environment variables may select a configuration file or supply secrets, but the presence of a credential never silently enables a module.

Conceptually:

```ts
createSuperConsole({
  adapters: [
    createAuthFnAdminAdapter(authAdminService),
    createWatchFnAdminAdapter(watchAdminService),
    createCatchFnAdminAdapter(catchAdminService),
    createLogFnAdminAdapter(logAdminService),
    createCiFnAdminAdapter(ciAdminService)
  ],
  enabledModules: ["authfn", "watchfn", "catchfn", "logfn", "cifn"],
  auth: authFnOperatorAuth,
  shellPolicy,
  audit: durableAuditSink,
  idempotency: durableIdempotencyStore,
  confirmation: confirmationService
});
```

A disabled-module request returns canonical not-found behavior so installation composition is not disclosed.

## Request lifecycle

1. authenticate the actor using AuthFn-backed session or service credentials;
2. resolve organization/workspace, project, and environment context;
3. for unsafe HTTP/MCP requests, run AuthFn mutation authorization and CSRF checks;
4. locate an enabled operation and validate its input;
5. evaluate scope, declared permission, and contextual policy;
6. verify confirmation and reserve idempotency when applicable;
7. append a sanitized `attempted` audit event; abort without invoking the adapter if that required write fails;
8. invoke the function-owned adapter, validate and redact its output, append the terminal audit event, and durably complete idempotency;
9. return the normalized result and terminal audit identity.

UI requests, direct REST calls, SDK requests, and McpFn tools enter at step one and converge on the shared dispatcher before domain execution. WatchFn/LogFn telemetry is supplied through the injected audit/observability services rather than emitted by a parallel console-only code path.

## Failure behavior

- Unknown or disabled module/operation: not found.
- Missing identity: unauthenticated.
- Invalid tenant selection: not found when disclosure would leak membership, otherwise forbidden.
- Policy denial: forbidden with a stable reason code.
- Schema failure: validation error with field issues.
- Idempotency collision: conflict.
- Domain conflict: normalized conflict preserving safe domain metadata.
- Dependency unavailable: service unavailable with retry guidance.
- Unexpected failure: opaque internal error with request ID; detailed data stays in server telemetry.

Secrets, tokens, raw credentials, private message bodies, and configured redaction fields never enter generic error or audit envelopes.

The pre-mutation audit record preserves intent when a later terminal append fails after a domain change. The interface does not claim cross-store atomicity between independently supplied domain, audit, and idempotency stores; production composition should colocate or transactionally coordinate them where a function requires a stronger guarantee.

## Persistence

The kernel defines interfaces rather than a mandatory database. Self-hosters bind supported DataFn or `@superfunctions/db` adapters. A function that accepts a shared database adapter wraps it with its own schema and namespace before use, consistent with repository rules.

Audit and idempotency stores must be durable in multi-process deployments. In-memory implementations are permitted only in tests or explicitly single-process development mode.
