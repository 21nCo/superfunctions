# UserFn feedback service

`@userfn/service` provides the dedicated feedback persistence path through shared HTTP, auth and database abstractions. It is a Node ESM package. Consumers provide the HTTP framework adapter and database connection; this package does not re-export or duplicate them.

```typescript
import { createUserFnService, getUserFnSchema } from '@userfn/service';

const { router } = createUserFnService({
  database, // shared Adapter; do not pass adapterSchema when constructing it
  auth: authProvider,
  // Optional trusted application policy, required when the provider lacks tenant/scopes:
  resolveAccess: async session => {
    const binding = await keyBindings.findByActorId(session.subject.actorId);
    return binding ? { tenantId: binding.tenantId, scopes: binding.scopes } : null;
  },
  allowedOrigins: ['https://app.example.com'], // omit for server-only clients
});
// Mount router with a shared HTTP framework adapter, or call router.handle(request).
// Apply getUserFnSchema() through your shared database migration workflow first.
```

Authentication must verify credentials on every request. Only explicit bearer credentials are accepted; cookies are removed before authentication. By default the verified session must include `subject.tenantId` and explicit `userfn:feedback:write` / `userfn:feedback:read` scopes. The optional access resolver runs only after valid, unexpired authentication and supplies a trusted server-side tenant and permission mapping. It cannot replace the authenticated actor. Missing tenant, mapping or permission fails closed with 403. Credential failures return 401; provider/storage outages return sanitized 503.

The current AuthFn API-key provider returns the key ID as actor and key scopes in `metadata.scopes`, with no tenant. Supplying that raw provider alone therefore returns 403. Bind its verified actor ID to a tenant in trusted application storage, and map its verified scopes or application policy through `resolveAccess`. Never derive these values from request headers, feedback fields or claimed client identity. Key issuance, rotation and tenant enrollment remain the host application's responsibility. The dedicated AuthFn acceptance test issues and revokes actual keys through its authenticated API-key plugin routes and uses the real provider. It uses AuthFn repository source with the current shared stack; the older published AuthFn dependency closure is not validated.

## Routes and persistence contract

- `POST /feedback`: JSON `{feedback, context: {source: "in_app", user: {id, traits} | null}}`. Requires write scope. Title/body/category and optional tags, attachments, priority and score are validated before writes. Unknown authority fields are rejected. Default request limit is 65,536 bytes.
- `Idempotency-Key`: 1–128 ASCII letters/digits/dot/underscore/colon/hyphen. SDKs generate it once per call. A tenant-scoped digest is the row primary key. Matching actor and canonical payload replay returns 200; first committed write returns 201; conflicting reuse returns 409. Both success responses contain `{id, accepted: true}`. Omitted keys are generated server-side and cannot deduplicate independent callers.
- `GET /feedback/:id`: requires read scope, filters by authenticated tenant and ID, and returns stored payload, authoritative actor, timestamp, initial status `open` and votes `0`. Missing or another tenant's row returns 404. Client identity/traits remain untrusted metadata.
- Invalid input returns 400, oversized input 413, and persistence failures 503. Responses disable caching. Explicit CORS origins support browser preflights without cookies.

The service wraps the incoming shared adapter with its own schema. Create the actual `userfn_feedback` table before serving traffic; `id` must have a primary-key/unique constraint for race-safe idempotency. `getUserFnSchema()` exposes fields and indexes. This package does not create tables, close caller-owned adapters or claim that a memory adapter is durable. Idempotency lasts while its row is retained; no TTL/retention worker is implemented.

## Validation and current limits

Run `npm test --workspace=@userfn/service` for service contract tests, `npm run test:native --workspace=@userfn/service` for file-backed SQLite, actual loopback HTTP, and both SDKs, and `npm run test:authfn --workspace=@userfn/service` for real AuthFn issuance/revocation through its provider. The latter uses AuthFn memory storage and UserFn file-backed SQLite; it does not prove durable AuthFn credentials. Native acceptance requires a compatible better-sqlite3 build and `uv` with Python 3.10. It closes and reopens SQLite before reading both languages' submissions; it also covers response loss after commit, concurrent duplicate/conflicting keys, tenant isolation and database failure.

This checkpoint implements feedback submission/readback, not the complete UserFn product. Config delivery, feedback listing/board/voting/status mutation, external sources, offline queues, moderation, retention, rate limiting, deployment and real browser/framework/hosted-provider acceptance remain open. PostgreSQL/MySQL/other adapters are not validated here. Local SQLite reopen proves that local storage boundary, not hosted durability or disaster recovery. HTTPS termination and narrowly scoped browser credentials are deployment responsibilities.
