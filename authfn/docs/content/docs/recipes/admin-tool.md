---
title: Building an admin tool
description: Mount @authfn/admin behind your corporate IAM and ship a UI for support.
---

# Building an admin tool

> This recipe describes the legacy low-level AuthFn router. For new operator
> tooling, use Super Console with `createAuthFnAdminAdapter`; it shares bound
> confirmation, durable idempotency, attempted/terminal audit, REST/OpenAPI,
> and McpFn semantics with every enabled Superfunction.

## Goal

Give your support team a UI to look up and delete users, gated behind your corporate IAM (Okta, Entra, in-house OIDC, …).

## Stack

- `@authfn/admin` for the routes.
- Your existing IAM for authentication / authorization.
- A small Svelte / React UI.

## Authorization callback

```ts
import { createAuthFnAdmin } from '@authfn/admin';

const admin = createAuthFnAdmin({
  authFnConfig: auth.config,
  authorize: async (ctx, input) => {
    const user = await yourCorporateAuth.authenticate(ctx.request);
    if (!user) return false;

    if (input.operationId === 'deleteAuthFnAdminUserById' && !user.permissions.includes('users:delete')) {
      return false;
    }

    return { allowed: true, actorId: user.id, metadata: { roles: user.roles } };
  },
});
```

## Mount

Mount under a path that your reverse proxy gates on the corporate VPN / SSO:

```ts
app.route('/internal/auth-admin', toHono(admin.router));
```

## UI

The UI is a thin shell over the admin routes:

- `GET /internal/auth-admin/users?search=ada@` — search.
- `DELETE /internal/auth-admin/users/:userId` — delete by id.
- `DELETE /internal/auth-admin/users/by-email/ada%40example.com` — delete by email.

The browser prompt below is only a user-experience guard. It is not a
server-bound confirmation token and does not make the legacy route equivalent
to the shared administration dispatcher:

```svelte
<button on:click={() => confirmAndDelete(user)}>Delete</button>

<script>
  async function confirmAndDelete(user) {
    if (!confirm(`Permanently delete ${user.primaryEmail}?`)) return;
    await fetch(`/internal/auth-admin/users/${user.id}`, { method: 'DELETE' });
  }
</script>
```

## Audit

The legacy delete operation emits an `authfn.account.deleted` observation with
the `actorId` returned by your authorization callback. That domain observation
is not the shared pre-mutation intent plus terminal-outcome audit contract.
Pipe it to protected telemetry during migration, but use the AuthFn capability
adapter for new compliance-sensitive administration.

## Related

- [Admin](../admin)
- [Concepts → Observability](../core-concepts/observability)
