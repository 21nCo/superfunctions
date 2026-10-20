# AuthFn feedback acceptance — 2026-10-20

This follow-up closes the prior fixture-only AuthFn compatibility gate for the local repository source path. `npm run test:authfn --workspace=@userfn/service` passes one focused integration acceptance. No UserFn production implementation changes were needed.

The test instantiates the actual `authfn({plugins: [authFnApiKeyPlugin()]}).createServer(...)`, creates a user and real cookie session through AuthFn core APIs, then issues keys through the plugin's POST `/auth/api-keys` route using the session cookie and CSRF token. The actual provider verifies the generated secret, loads its hashed record and updates last-used state. UserFn uses that provider directly with an explicit trusted key-ID-to-tenant resolver and the key's verified scopes.

Acceptance covers:

- AuthFn-issued key produces a committed feedback receipt and authoritative key actor ID.
- Client identity/traits and spoofed tenant/actor headers do not override server authority; top-level tenant payload injection returns 400.
- Same idempotency key is isolated between two tenants; cross-tenant read returns 404.
- Read-only keys and keys without trusted tenant enrollment return 403. Invalid credentials return 401 even when a valid administrative cookie accompanies the request; UserFn excludes cookies before calling the provider.
- UserFn's actual file-backed SQLite connection is closed and reopened. Authorized read and same-key replay continue to work with persisted feedback.
- Revocation through AuthFn DELETE `/auth/api-keys/:id` immediately causes UserFn writes and reads to return 401, including a new idempotency key. Another tenant's key remains valid. Only the two intended rows exist.

Validation: `npm run test:authfn --workspace=@userfn/service` passes; `npm run build --workspace=@userfn/service` and existing eight service contracts pass. The separate both-SDK loopback/native acceptance remains in `feedback-service-readiness.md` and was not replaced by this Request/Response router test.

## Limits

AuthFn uses shared memoryAdapter here; UserFn uses real SQLite. AuthFn's canonical core date fields declare timestamptz/Date storage, so durable SQLite AuthFn provisioning needs a separate supported schema/storage integration. This test deliberately keeps AuthFn's in-memory key store alive while reopening UserFn SQLite; it makes no AuthFn durability claim.

The isolated test configuration resolves actual AuthFn/API-key plugin repository source and shared HTTP/DB/OpenAPI/OAuth source where needed. AuthFn's current manifest pins older shared DB 0.1.4 and HTTP 0.1.3; those packaged dependencies are not certified by this source acceptance. No AuthFn or shared code/manifests were changed. Packed AuthFn closure, real framework/browser hosting, credential enrollment/rotation deployment and non-SQLite/hosted database acceptance remain open. This adds no hosted resources, publication or production key material.
