# TypeScript admin SDK

## Purpose

The TypeScript client consumes the versioned REST API. It does not import SvelteKit or server domain implementations and can be used by Node, Bun, edge runtimes, browsers with an authorized proxy/session, scripts, and tests.

## Client model

Construction accepts:

- base URL;
- a static header set or asynchronous header callback for AuthFn/API-key authentication and scope headers;
- fetch implementation;
- optional default idempotency and confirmation values.

Per-request options accept additional headers, an abort signal, an idempotency key, and a confirmation token. Scope is carried in the canonical query parameters or headers documented by the REST API; the client does not keep mutable global scope.

## Surfaces

- `client.registry()` discovers enabled capabilities.
- `client.overview()`, `client.search(...)`, `client.audit(...)`, `client.settings()`, and `client.mcp()` expose shared shell capabilities.
- `client.openApi()` reads the enabled OpenAPI document.
- `client.issueConfirmation(operationId, input)` requests an actor/scope/operation/input-bound confirmation token.
- `client.invoke(moduleId, route, input)` calls a discovered module route.
- `client.invokeOperation(operationId, input)` calls the operation-ID transport.

The client is intentionally transport-level in v1. Function `admin` packages publish typed capability manifests and server adapter/service contracts; they do not yet ship generated function-specific REST client methods. `invoke` and `invokeOperation` therefore accept transport-level `unknown` input. Generated per-module clients, operation-specific input/output types, automatic cursor iterators, and discovery-cached preflight checks require a later schema-generation pass and are not implemented yet.

## Mutations

Mutation options support:

- idempotency key;
- explicit confirmation token when required by capability metadata;
- abort signal;
- additional headers, including function-declared optimistic version or correlation headers where a deployment supports them.

The returned administration envelope can expose `auditId`, `requestId`, correlation ID, replay/deduplication metadata, warnings, and domain data when supplied by the server.

## Errors

The SDK throws `AdminClientError` with the HTTP status and normalized administration response when one was returned. The response carries the stable code, safe message/details, retryability, request ID, correlation ID, and audit ID supported by the server.

The v1 client performs no automatic retries. Callers may retry an idempotent mutation only with the same idempotency key and identical input.

## Capability typing

Manifest, operation, scope, result, and error types are exported by `@superfunctions/admin`. Runtime discovery determines which function capabilities are enabled. The server remains authoritative and returns not-found behavior for disabled modules; the v1 client does not cache discovery or manufacture local availability errors.

## Verification

Contract tests assert that:

- registry and shared-surface envelopes unwrap correctly;
- route and operation invocation preserve administration envelopes;
- idempotency and confirmation headers are emitted correctly;
- normalized failures retain their response and HTTP status;
- asynchronous authentication/header callbacks and abort signals are applied consistently.
