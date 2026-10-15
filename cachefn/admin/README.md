# @cachefn/admin

Administration for a deployment-bound `@cachefn/core` cache. Operations list key
names, check key existence, read counters, set/delete keys, invalidate tags and
clear the bound namespace. Read operations never return cached values. Set
values are redacted from audit records.

## Integration boundary

Register `createCacheFnDomainAdminAdapter({ cache, environmentId, namespace })`
with `createAdminRegistry`, enable the `cachefn` module, and invoke operations
through `createAdminDispatcher` from `@superfunctions/admin`. The adapter and
service are domain components: calling `adapter.execute()` or service methods
directly does **not** authenticate a caller or enforce operation permissions,
input/output schemas, confirmation, auditing or idempotency.

```typescript
import { createAdminDispatcher, createAdminRegistry } from '@superfunctions/admin';
import { createCacheFnDomainAdminAdapter } from '@cachefn/admin';

// cache is the application's actual namespace-scoped CacheFn instance.
const registry = createAdminRegistry({
  adapters: [createCacheFnDomainAdminAdapter({
    cache,
    environmentId: 'production-environment',
    namespace: 'tenant-a',
  })],
  enabledModules: ['cachefn'],
});
const dispatcher = createAdminDispatcher({
  registry,
  audit: durableAuditSink,
  idempotency: durableIdempotencyStore,
  confirmation: scopedConfirmationVerifier,
  policy: applicationAuthorizationPolicy,
});
// Mount this dispatcher using the shared admin transport integration.
// Derive actor permissions and scope from authenticated server-side context.
// Never accept a client's asserted actor/scope as authenticated context.
```

The infrastructure identifiers in this example must be supplied by the host.
Use durable shared stores for audit/idempotency in production and a confirmation
verifier that binds proof to the actor, target, operation, scope and freshness
requirements. An allow-all verifier or an in-memory audit store is not a
production replacement. Required infrastructure fails closed when missing.

All operations require environment scope. Binding a namespace additionally
requires matching `context.scope.namespace`; omitting it means an
environment-wide binding. Bind the actual cache instance for that environment
and namespace. Deletion requires recent authentication; whole-namespace clear
requires MFA confirmation as declared by the capability. Writes require audit
and idempotency infrastructure. Tag invalidation has its own write permission.
Key names themselves can be sensitive: grant `cachefn.keys.read` deliberately.

## Validation

The package tests exercise the bound service and the real shared dispatcher.
They cover denied actors, invalid input, environment/namespace mismatch, missing
confirmation/audit infrastructure, redacted successful writes, and confirmed
namespace clear. The test verifier accepts a deterministic fixture token;
production verification remains the host's responsibility.

```bash
npm test --workspace @cachefn/admin
npm run typecheck --workspace @cachefn/admin
```
