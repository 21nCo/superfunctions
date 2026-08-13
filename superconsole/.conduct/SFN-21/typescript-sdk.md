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

The shared `AdminClient` remains the language-neutral REST transport boundary.
Each available function package publishes `create<Function>AdminClient(...)`,
which wraps it with:

- an exact operation-ID method map under `operations`;
- `availability()` against the live enabled registry;
- typed `invoke(...)` where the function preserves operation input/output types;
- `pages(...)`, an async cursor iterator that retains request/audit receipts.

Functions migrated to real domain bindings also export operation input/output
maps and typed service/adapter constructors. Generic `unknown` domain payloads
are not accepted as proof that a function has a commercial admin API. A
function without a canonical server/store is marked unavailable rather than
publishing fictional generated methods.

## Mutations

Mutation options support:

- idempotency key;
- explicit confirmation token when required by capability metadata;
- abort signal;
- additional headers, including function-declared optimistic version or correlation headers where a deployment supports them.

The returned administration envelope can expose `auditId`, `requestId`, correlation ID, replay/deduplication metadata, warnings, and domain data when supplied by the server.

Named clients surface intentional one-time credentials only on operations whose manifests require audit, strong confirmation, and non-idempotent execution. Callers must capture that successful response immediately; the credential is never recoverable from audit, errors, or an idempotent replay.

## Errors

The SDK throws `AdminClientError` with the HTTP status and normalized administration response when one was returned. The response carries the stable code, safe message/details, retryability, request ID, correlation ID, and audit ID supported by the server.

The v1 client performs no automatic retries. Callers may retry an idempotent mutation only with the same idempotency key and identical input.

## Capability typing

Manifest, operation, scope, result, and error types are exported by `@superfunctions/admin`. Runtime discovery determines which function capabilities are enabled. The server remains authoritative: disabled modules are absent, while explicitly unavailable packages fail startup selection with their domain-binding reason. Function clients expose this through `availability()` without treating package installation as runtime enablement.

## Verification

Contract tests assert that:

- registry and shared-surface envelopes unwrap correctly;
- route and operation invocation preserve administration envelopes;
- idempotency and confirmation headers are emitted correctly;
- normalized failures retain their response and HTTP status;
- asynchronous authentication/header callbacks and abort signals are applied consistently.
- capability operation maps preserve exact operation IDs;
- availability reflects the live enabled registry;
- page iterators forward cursors, preserve receipts, and reject repeated cursors.
