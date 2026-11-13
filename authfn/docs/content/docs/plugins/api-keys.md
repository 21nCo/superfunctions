---
title: API keys plugin
description: User-owned and server-issued unowned API keys — hashed, scoped, revocable.
---

# API keys plugin

`authFnApiKeyPlugin` lets signed-in users issue user-owned API keys and use them as bearer tokens against your service. Trusted TypeScript server code can also issue unowned service keys with the exported `createApiKey` helper. Keys are:

- **User-owned or unowned** — cookie-session routes bind keys to the signed-in user's `userId`; trusted server code can explicitly pass `userId: null` to issue an unowned service key.
- **Hashed at rest** — the plaintext is shown once at creation; only `secretHash` is persisted.
- **Scoped** — keys carry `<owner>:<action>` scopes from the registry your app declares; `requireScopes` enforces them.
- **Named** — for a user's UI or a service ("CI", "personal laptop", "retrieval-worker").
- **Revocable** — cookie-session routes revoke the caller's user-owned keys; trusted server code can revoke unowned keys with `revokeApiKeyById`. Both set `revokedAt`.

```ts
import { authfn, authFnPlugins } from 'authfn';
import { authFnApiKeyPlugin } from '@authfn/api-keys';

const authApp = authfn({
  scopes: { repo: ['read', 'write'], account: ['read'] },
  plugins: authFnPlugins(authFnApiKeyPlugin({ secretPrefix: 'sk_live_' })),
});
```

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `secretPrefix` | `'authfn_'` | Prefix for the issued secret string. Useful for vendor-specific keys (`sk_live_`, `prj_`). |
| `now` | `() => new Date()` | Clock injection for tests. |

The scope registry is the `scopes` option on `authfn()` itself, not a plugin option; see [Scopes](#scopes).

## Routes

| Method | Path | Operation ID | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/api-keys` | `createApiKey` | Body: `{ name?, scopes?, expiresAt?, metadata? }`. Returns plaintext once. A scope outside the registry fails with HTTP 400 and stores nothing. |
| `GET` | `/auth/api-keys` | `listApiKeys` | Lists the caller's keys. Plaintext is never returned again. |
| `DELETE` | `/auth/api-keys/:keyId` | `revokeApiKey` | Revokes a key. |

## Schema

| Table | Purpose |
| --- | --- |
| `authfn_api_keys` | One row per key: `{ id, userId, secretHash, name, scopes, metadata, expiresAt, revokedAt, lastUsedAt, createdAt, updatedAt }`. |

## Authentication via API key

When a request carries `Authorization: Bearer <secret>`, the TypeScript `authfn` kernel (0.5.0 and later):

1. Looks up the key by `secretHash`; returns `null` if no key matches.
2. Throws `AUTHFN_API_KEY_REVOKED` if `revokedAt` is set.
3. Returns `null` if `expiresAt` is at or before the current time.
4. For a user-owned key, loads the owner; returns `null` if the owner was deleted or is disabled (`metadata.disabled === true` on the user record).
5. Updates `lastUsedAt`.
6. Synthesizes an `AuthFnSession` with `type: 'api-key'`, `methods: ['api-key']`, `scopes` set to the key's stored scopes that the registry can grant (`[]` when it has none), and `credential: { type: 'api-key', id: <keyId> }`.

In the TypeScript `authfn` package (0.5.0 and later), a user-owned key acts as its owner: the session carries `actorType: 'user'` and `actorId` set to the owner's user ID, so data you key by `actorId` is the owner's data. An unowned service key keeps `actorType: 'api-key'` with the key ID as `actorId`. AuthFn looks up the key and loads its owner only in the configured `namespace`; with an adapter that isolates namespaces, a key or owner from another tenant authenticates as no one.

`session.metadata.ownerUserId` still carries the owner's user ID for one more minor version. It is deprecated; read `session.actorId` instead.

> **Python SDK:** the Python `authfn` package has not adopted these rules or the scope registry yet. Its API-key sessions keep `actor_type` `'api-key'` with the key ID as `actor_id`, expose the owner only through `metadata.ownerUserId` (which metadata stored on the key can override), have no `credential` field, and do not check whether the owner was deleted or disabled. Disabling a user does not cut off their keys in a Python host; revoke the keys as well. See [SDKs → Python](../sdk/python#api-key-sessions).

The synthesized session is what `auth.provider.authenticate(request)` returns. To tell a key apart from an interactive sign-in, branch on `session.type` (or `session.credential`), not on `session.actorType`. To authorize a request, call `requireScopes` (below) on any session rather than branching on its type.

## Issued plaintext shape

```ts
const created = await client.createApiKey({ name: 'CI', scopes: ['repo:read'] });
console.log(created.secret);   // shown once: "sk_live_<random>"
```

The plaintext follows `<secretPrefix><base64url(random)>`. Display it once, then redirect to a "you can't see this again" UI.

## Scopes

A scope is `<owner>:<action>`: the owner is an app or API (`repo`, `memotron`) and the action is what it allows (`read`, `write`). Declare every scope your app accepts as a registry on `authfn()`; each owner maps to its actions:

```ts
import { authfn, defineAuthFnScopes } from 'authfn';

const scopes = defineAuthFnScopes({
  repo: ['read', 'write'],
  account: ['read'],
});

const authApp = authfn({ scopes, plugins: authFnPlugins(authFnApiKeyPlugin()) });
```

Owners and actions are 1–64 characters of `a-z`, `0-9`, `_`, `.` or `-`, starting with a letter or digit. `createServer` throws `AUTHFN_CONFIG_INVALID` for a malformed registry.

A key may be granted:

| Scope | Grants |
| --- | --- |
| `repo:read` | Exactly that registered scope. |
| `repo:*` | Every action of the registered owner `repo`. |
| `*` | Every registered scope. |

Creating a key with any other scope, through the route or the `createApiKey` helper, fails with `AUTHFN_VALIDATION_ERROR` (HTTP 400) and `details.unknownScopes`; nothing is stored. Without a registry only `*` is accepted. A key created without scopes grants nothing.

Every session carries `scopes: string[]`. Interactive cookie and bearer sessions carry `['*']`, so a signed-in user passes every check; an API-key session carries its key's stored scopes that the registry can grant. `requireScopes(session, needed)` is the shared check: it throws `AUTHFN_UNAUTHENTICATED` (401) when there is no session and `AUTHFN_INSUFFICIENT_SCOPE` (403, with `details.missingScopes`) unless the session grants every needed scope. `hasScopes` returns the same answer as a boolean. Both read only `session.scopes`; `session.metadata` is never a grant. Needed scopes must be concrete `<owner>:<action>` pairs; pass `{ registry: scopes }` to also check that each one is registered (and to type-check them against the registry). Either mistake is a host bug and throws a `TypeError`.

Keys created before `authfn` 0.6.0 were never validated. When such a key authenticates, its session keeps only the stored entries the current registry can grant: a registered scope, `<owner>:*` for a registered owner, or `*`. Any other stored entry, such as an unregistered scope or `<owner>:*` for an unregistered owner, grants nothing, and a key with no stored scopes grants nothing. A legacy key that stored `*` still grants every registered scope, and a stored `<owner>:*` grants every action of that owner, so audit such keys and reissue them with narrower scopes. The deprecated `session.metadata.scopes` still lists every stored string but is never a grant.

Return HTTP 401 for a missing or invalid credential and HTTP 403 for a missing scope. In this example, `auth` is your AuthFn server and `handleAuthorizedRequest` is your application's protected handler; it only runs after the scope check passes.

```ts
import { AuthFnError, requireScopes, type AuthFnSession } from 'authfn';

async function handleRepositoryRequest(request: Request): Promise<Response> {
  let session: AuthFnSession | null;
  try {
    session = await auth.provider.authenticate(request);
    requireScopes(session, 'repo:read');
  } catch (error) {
    if (error instanceof AuthFnError && (error.status === 401 || error.status === 403)) {
      const body = { error: error.status === 401 ? 'unauthorized' : 'forbidden' };
      return Response.json(body, { status: error.status });
    }
    throw error;
  }
  return handleAuthorizedRequest(request, session);
}
```

Missing, invalid, expired, or revoked credentials receive HTTP 401; a session without `repo:read` receives HTTP 403. The catch maps only AuthFn's 401 and 403 errors; unexpected failures propagate to your host's error handler, and protected work stays outside the catch. Inside AuthFn's own router you can let `requireScopes` throw: AuthFn's error handler maps `AUTHFN_INSUFFICIENT_SCOPE` to HTTP 403.

## Unowned service keys

Trusted server code can issue an unowned key with the exported `createApiKey` helper. Pass `userId: null` explicitly, along with your server's database adapter and namespace:

```ts
import { createApiKey, revokeApiKeyById } from 'authfn/core/api-keys';

// `scopes` is the same registry you pass to authfn().
const config = { database, namespace: 'authfn', scopes };
const serviceKey = await createApiKey(config, {
  userId: null,
  name: 'retrieval-worker',
  scopes: ['repo:read'],
  metadata: { servicePrincipalId: 'service:retrieval-worker' },
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
});

// Before distributing serviceKey.secret, persist serviceKey.keyId in your
// application's authorized service-key inventory and audit the issuance.

// After checking your application's service-principal management policy:
await revokeApiKeyById(config, serviceKey.keyId);
// Update your inventory and audit the successful revocation.
```

These keys persist a null owner, use the same hashed-secret, expiry, and revocation behavior, and authenticate as `actorType: 'api-key'` with the key ID as their actor ID. Host routes that require `actorType: 'user'` reject them. Authentication exposes the stored scopes the registry can grant in `session.scopes` (every stored string is still mirrored, deprecated, in `session.metadata.scopes`) and leaves `session.metadata.ownerUserId` undefined. Your application must authorize service-principal issuance and use, and must call `requireScopes` on its routes; the helper does not create a user identity.

Unowned keys authenticate through the normal `auth.provider.authenticate` path only. The opt-in [placement-context issuer](../recipes/placement-bound-auth-context) (`createAuthFnPlacementContextIssuer`) binds each API-key grant to its owning user's placement, so it rejects an unowned key with `AUTHFN_UNAUTHENTICATED`. Use a user-owned key when a service must derive placement-bound context. The issuer applies the same owner check as `auth.provider.authenticate`: a key whose owner was deleted or is disabled fails with `AUTHFN_UNAUTHENTICATED` before any consumer runs or assertion is signed.

AuthFn's own account routes (`GET /auth/session`, `GET`/`DELETE /auth/account`), password linking during sign-up, and the operator console accept only interactive sessions (`type: 'session'`), so a user-owned key cannot manage its owner's account even though it acts as that user.

The cookie-session routes above remain user-owned: creation always uses the signed-in user's ID, and user listing and revocation exclude unowned keys. Manage unowned keys through trusted server code after applying your application's authorization policy.

### Service-key inventory and audit ownership

Keep a durable, access-controlled inventory mapping each `keyId` to its service principal, name, scopes, expiry, and revocation state. Record the ID before distributing the secret: `revokeApiKeyById` requires that ID, and the user listing route cannot discover unowned keys. Use bounded expiries, as in the example, to limit the lifetime of keys whose management records are lost.

Inventory persistence, secret delivery, and recovery are application-owned. The helpers do not make inventory or audit writes atomic with issuance. If inventory persistence fails, do not distribute the secret; use the still-known key ID to attempt revocation and reconcile any cleanup failure through your application's operational tooling.

Direct `createApiKey` and `revokeApiKeyById` calls do **not** emit the HTTP route events listed below. Audit successful service-key issuance and revocation in your application, recording the authorized management actor, service principal, key ID, timestamp, and relevant scopes. Exclude the plaintext secret and secret hash from inventory and audit logs.

## Revocation

```ts
await client.revokeApiKey({ keyId });
```

After revocation, `auth.provider.authenticate(request)` rejects with `AUTHFN_API_KEY_REVOKED`. AuthFn's HTTP error handler maps that error to HTTP 401; application-owned endpoints should return HTTP 401 as shown above. Unknown or expired keys instead authenticate to `null`.

## Errors

| Code | When |
| --- | --- |
| `AUTHFN_VALIDATION_ERROR` | Invalid name or expiresAt, `scopes` that is not an array of strings (`details.field` is `scopes`), or a scope outside the registry (`details.unknownScopes`). |
| `AUTHFN_INSUFFICIENT_SCOPE` | `requireScopes` found a needed scope the session does not grant (`details.missingScopes`). |
| `AUTHFN_UNAUTHENTICATED` | Caller is not signed in (key creation requires a session). |
| `AUTHFN_API_KEY_REVOKED` | Key was used after revocation. |
| `AUTHFN_NOT_FOUND` | `revokeApiKey` for a missing key id. |

## Events

The cookie-session HTTP routes emit these events:

- `authfn.api_key.created`
- `authfn.api_key.revoked`

Trusted persistence helpers do not emit them; direct service-key lifecycle auditing is the application's responsibility.

## Quick UI: list and revoke keys

```ts
const { keys } = await client.listApiKeys();
keys.forEach(({ id, name, lastUsedAt, scopes, createdAt }) => render({ id, name, lastUsedAt, scopes, createdAt }));

// On user clicks "revoke":
await client.revokeApiKey({ keyId });
```

The Svelte and Swift SDKs ship out-of-the-box list/create/revoke views; see [SDKs → Svelte](../sdk/svelte) and [Examples → account-settings](../examples/account-settings).

## Related

- [Concepts → Sessions](../core-concepts/sessions) — API key sessions.
- [Recipes → CLI authentication](../recipes/cli-auth) — issuing keys for command-line tools.
