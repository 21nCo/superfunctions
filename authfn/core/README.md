# authfn

`authfn` is the session and identity kernel for the Superfunctions ecosystem. It composes declared plugins, manages browser sessions, generates schema/OpenAPI output, and provides `@superfunctions/auth` provider integration without bundling every auth method into the root package.

## Install

```bash
npm install authfn
```

Install only the plugin packages you use (`@authfn/password`, `@authfn/email-otp`, `@authfn/social-oauth`, `@authfn/api-keys`, `@authfn/two-factor`, `@authfn/multi-region`, `@authfn/native-handoff`) plus `@authfn/client` for browsers.

## 0.6.2 release

A `429 AUTHFN_RATE_LIMITED` refusal now reports in `details.resetAt` the end of the fixed window that refused the request. Refused retries in the same window all report that same time, and a request at or after it is counted in a new window. Before, `resetAt` was the refusal time plus `windowSeconds`, so every refused retry reported a later reset. In `local` mode, counters now expire at the window boundary instead of `windowSeconds` after their first request. Rate-limit counters were already kept per route category (`otp-send`, `otp-verify`, `password`, …) and per fixed window in every mode; the counter keys are unchanged, so existing counters carry over after an upgrade.

`rateLimit.policies.<category>.windowSeconds` must now be a finite number from 0.001 (one millisecond) to 4,320,000,000,000 seconds. Creating the server with any other value (0, a negative number, `NaN` or `Infinity`) throws `AuthFnConfigError` (`AUTHFN_CONFIG_INVALID`) naming the category. Before, such values were accepted, and a refusal could then report an invalid or already-passed reset time or fail with a 500 error instead of a 429.

`@authfn/api-keys` 0.2.2, `@authfn/email-otp` 0.1.6, `@authfn/multi-region` 0.2.2, `@authfn/native-handoff` 0.1.6, `@authfn/oauth-provider` 0.3.3, `@authfn/password` 0.1.7, `@authfn/social-oauth` 0.1.6 and `@authfn/two-factor` 0.1.6 depend on `authfn` 0.6.2; upgrade them together so only one copy of `authfn` is installed.

## 0.6.1 release

The email OTP attempt limit (`maxAttempts`, default 5) now holds when wrong codes for one challenge are submitted concurrently. Each verification reserves an attempt with a conditional write before it compares the code, so a challenge is compared at most `maxAttempts` times for wrong codes; before, parallel requests that read the same attempt count were all compared while the stored count rose by one. A request that cannot reserve an attempt gets `400 AUTHFN_OTP_INVALID`, except when it finds the challenge already consumed, which gives `409 AUTHFN_OTP_REPLAYED`. A correct code that is rejected without consuming the challenge (for example, sign-in for an email with no user) hands its attempt back only when no other request reserved an attempt or consumed the challenge in between and that write succeeds; otherwise the attempt stays counted. Before, such a code never counted. The write is acknowledged by the row `update` returns on adapters that support `RETURNING` (memory, and Drizzle or Kysely on SQLite, D1 and Postgres) and by the affected-row count of `updateMany` on the others (Prisma, and Drizzle on MySQL). On MySQL, OTP verification therefore needs Drizzle with `@superfunctions/db` 0.3.0 or newer: with 0.2.x (including the 0.2.0 that `authfn` depends on) the Drizzle MySQL adapter reports no affected-row count, and Kysely on MySQL reports no rows from `updateMany` in every version through 0.3.2, so verification is rejected with `400 AUTHFN_OTP_INVALID` there. OTP verification did not succeed on either of those before this release (correct codes came back as `AUTHFN_OTP_REPLAYED`). `POST /auth/otp/verify` and password reset completion get the fix through `@authfn/email-otp` 0.1.5 and `@authfn/password` 0.1.6. Those, `@authfn/api-keys` 0.2.1, `@authfn/multi-region` 0.2.1, `@authfn/oauth-provider` 0.3.2, and `@authfn/native-handoff`, `@authfn/social-oauth` and `@authfn/two-factor` 0.1.5 depend on `authfn` 0.6.1; upgrade them together so only one copy of `authfn` is installed.

## 0.6.0 release

Scopes are now enforced. Declare the scopes your app accepts as a registry on `authfn()`, then call `requireScopes` before protected work:

```ts
import { authfn, authFnPlugins, defineAuthFnScopes, requireScopes } from 'authfn';
import { authFnApiKeyPlugin } from '@authfn/api-keys';

const scopes = defineAuthFnScopes({ memotron: ['read', 'write'], pointron: ['read', 'write'] });
const authApp = authfn({ scopes, plugins: authFnPlugins(authFnApiKeyPlugin()) });
const auth = authApp.createServer({ database }); // database: your @superfunctions/db adapter

const session = await auth.provider.authenticate(request);
requireScopes(session, 'memotron:read', { registry: scopes }); // 401 without a session, 403 AUTHFN_INSUFFICIENT_SCOPE without the scope
```

- Every session carries `scopes: string[]`. Cookie and bearer user sessions get `['*']`; API-key sessions get the key's stored scopes that the registry can grant.
- A scope is `<owner>:<action>`. `<owner>:*` grants every action of that owner and `*` grants every registered scope.
- API-key creation (the `POST /auth/api-keys` route and `createApiKey`) rejects any scope outside the registry with `400 AUTHFN_VALIDATION_ERROR` and `details.unknownScopes`. Without a registry only `*` is accepted. Trusted code calling `createApiKey` directly passes the registry as `config.scopes`.
- `session.metadata.scopes` is deprecated; read `session.scopes`.

Migration: declare a registry before creating keys with scopes. Keys stored before 0.6.0 were never validated, so an API-key session keeps only the stored entries the current registry can grant: a registered scope, `<owner>:*` for a registered owner, or `*`. Any other stored entry (an unregistered scope or an unregistered owner's `<owner>:*`) grants nothing, and a key stored without scopes grants nothing. A legacy key that stored `*` still grants every registered scope, and a stored `<owner>:*` every action of that owner, so audit such keys and reissue them with narrower scopes. The deprecated `session.metadata.scopes` still lists every stored string but is never a grant. `@authfn/api-keys` 0.2.0, `@authfn/password` 0.1.5, and `@authfn/email-otp`, `@authfn/social-oauth`, `@authfn/two-factor` and `@authfn/native-handoff` 0.1.4, and `@authfn/multi-region` 0.2.0 depend on `authfn` 0.6.0. Upgrade them together: an older plugin pins an older `authfn`, installs a second copy, and issues sessions without `scopes` (and `@authfn/multi-region` 0.1.3 re-exports a placement-context issuer that signs every stored API-key scope).

## 0.5.0 release

A session authenticated by a user-owned API key now acts as the key's owner: `actorType` is `'user'`, `actorId` is the owner's user ID, and the new `credential` field is `{ type: 'api-key', id: <keyId> }`. A host that keys data by `actorId` reaches the owner's data with the key. `type` stays `'api-key'`.

- A key whose owner was deleted or is disabled (`metadata.disabled === true` on the user record) authenticates as no one, through `auth.provider.authenticate` and through the placement-context issuer alike.
- An unowned service key keeps `actorType: 'api-key'` with the key ID as `actorId`, so routes that require a user reject it.
- `session.metadata.ownerUserId` is deprecated and stays for one more minor version; read `actorId`.
- AuthFn's own account routes and password linking still accept only interactive sessions (`type: 'session'`).

Migration: if your host detects API keys with `session.actorType === 'api-key'`, check `session.type === 'api-key'` (or `session.credential`) instead; owned keys no longer match the old check.

## 0.4.1 release

Concurrent sign-ups for the same email now return `409 AUTHFN_CONFLICT` to every request except the one that creates the user. Before, a request that passed the existence check but lost the insert to the unique index got a retryable `500 AUTHFN_INTERNAL_ERROR`. Password sign-up gets the fix through `@authfn/password` 0.1.3, which depends on `authfn` 0.4.1; `@authfn/password` and `@authfn/api-keys` 0.1.2 pin `authfn` 0.3.0. A storage conformance suite now runs password sign-in, sessions and API keys on better-sqlite3 and on a local Cloudflare D1 database in workerd; see [Self-hosting authfn on SQLite and D1](https://github.com/21nCo/super-functions/blob/dev/authfn/docs/content/docs/recipes/self-hosting-sqlite-d1.md).

## 0.4.0 release

The core API key helper accepts `userId: null` to create an unowned key for a trusted service principal. Existing user-owned keys remain supported.

```ts
import { createApiKey } from 'authfn/core/api-keys';

const key = await createApiKey(
  { database, namespace: 'authfn', scopes: { skills: ['read'] } }, // 0.6.0+: pass the app's registry
  {
    userId: null,
    name: 'service-worker',
    scopes: ['skills:read'],
    metadata: { servicePrincipalId: 'service:worker' }
  }
);
```

Call this helper only from trusted server-side provisioning code. Cookie-session API key management remains user-owned; it does not list or revoke unowned service keys. Core-only publication does not update the existing `@authfn/*` packages' dependency pins.

## Two-stage API

Declare a side-effect-free app, then inject runtime dependencies:

```ts
import { memoryAdapter } from '@superfunctions/db/testing';
import { authFnPlugins, authfn } from 'authfn';
import { authFnPasswordPlugin } from '@authfn/password';
import { authFnEmailOtpPlugin } from '@authfn/email-otp';

const authApp = authfn({
  namespace: 'authfn',
  plugins: authFnPlugins(
    authFnPasswordPlugin(),
    authFnEmailOtpPlugin()
  )
});

const auth = authApp.createServer({
  database: memoryAdapter({ debug: false }),
  pluginRuntime: {
    emailOtp: {
      delivery: {
        async send(input) {
          return { sent: true, metadata: { channel: input.channel } };
        }
      }
    }
  }
});
```

Mount `auth.router` with a `@superfunctions/http-*` adapter and use `auth.provider` anywhere an `@superfunctions/auth` provider is expected. `authApp.getSchema()` works without creating a server.

Full reference: [authfn docs → SDKs → authfn](https://authfn.superfunctions.dev/docs/sdk/core).
