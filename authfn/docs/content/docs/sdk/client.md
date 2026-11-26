---
title: "@authfn/client"
description: The TypeScript client — works in browsers, Node, Bun, Deno; cookie or bearer; with an automatic CSRF, region-aware routing, and a typed surface for every kernel route.
---

# @authfn/client

`@authfn/client` is the cross-runtime TypeScript client. Use it in:

- Browsers (cookie or bearer mode).
- Node, Bun, Deno (typically bearer mode).
- Service workers, edge functions.

```bash
npm install @authfn/client
```

## Quick start

```ts
import { createAuthFnClient } from '@authfn/client';

const client = createAuthFnClient({
  baseUrl: 'https://api.example.com/auth',
});

const session = await client.signInWithPassword({
  email: 'ada@example.com',
  password: 'correct horse battery staple',
});

if (session.ok) {
  console.log('signed in as', session.data.session?.primaryEmail);
} else {
  console.error(session.error.code, session.error.message);
}
```

## `createAuthFnClient(options)`

```ts
interface AuthFnClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  bearerToken?: string | (() => string | undefined | null | Promise<string | undefined | null>);
  cookieAccessor?: () => string | undefined;
  cookiePrefix?: string;
  credentials?: RequestCredentials;
  onRequestMetric?(metric: AuthFnClientRequestMetric): void;
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `''` | Origin + base path. |
| `fetch` | global `fetch` | Inject for tests / instrumentation. |
| `bearerToken` | unset | Pass a token (string or async getter) to enable bearer mode. |
| `cookieAccessor` | DOM `document.cookie` | For non-browser cookie environments. |
| `cookiePrefix` | `'authfn'` | Match the kernel's `cookie.prefix`. |
| `credentials` | `'include'` | Browser fetch credentials policy. |
| `onRequestMetric` | unset | Per-request observability hook. |

## Returned client

```ts
interface AuthFnClient {
  // Sessions
  getSession(): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;
  listSessions(): Promise<AuthFnListSessionsEnvelope | AuthFnErrorEnvelope>;
  revokeSession(input: { sessionId: string }): Promise<…>;
  signOut(input?: { allSessions?: boolean }): Promise<…>;

  // Account
  getAccountDetails(): Promise<AuthFnAccountDetailsEnvelope | AuthFnErrorEnvelope>;
  deleteAccount(): Promise<AuthFnDeleteAccountEnvelope | AuthFnErrorEnvelope>;

  // Password
  signUpWithPassword(input): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;
  signInWithPassword(input): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;
  startPasswordReset(input: { email: string }): Promise<AuthFnOtpEnvelope | …>;
  completePasswordReset(input): Promise<… | AuthFnErrorEnvelope>;

  // Email OTP
  sendOtp(input: { purpose; email; metadata? }): Promise<AuthFnOtpEnvelope | …>;
  verifyOtp(input: { purpose; email; code; profile?; sessionMode? }): Promise<…>;

  // Social OAuth
  startSocialSignIn(input: { provider; returnTo?; callbackMode?; handoffMode? }): Promise<…>;
  disconnectSocialAccount(input: { provider }): Promise<…>;

  // Native handoff
  startNativeHandoff(): Promise<…>;
  startWebHandoff(input?: { returnTo? }): Promise<…>;

  // API keys
  createApiKey(input): Promise<…>;
  listApiKeys(): Promise<…>;
  revokeApiKey(input: { keyId }): Promise<…>;

  // Two-factor
  enableTwoFactor(): Promise<…>;
  confirmTwoFactor(input: { code }): Promise<…>;
  completeTwoFactorChallenge(input: { challengeId; code }): Promise<…>;
  disableTwoFactor(input: { code }): Promise<…>;

  // Multi-region
  lookupRegion(input: { identifier }): Promise<…>;
  getEnvironment(): Promise<…>;
}
```

Every method returns a discriminated union: `{ ok: true, data, requestId }` on success, `{ ok: false, error, requestId }` on failure. No throws by default; check `ok` before using `data`.

## Cookie mode (default in browsers)

```ts
const client = createAuthFnClient({ baseUrl: 'https://api.example.com/auth' });
```

The client:

- Sends `credentials: 'include'` so cookies travel.
- Reads the CSRF cookie (default name: `authfn.csrf`) and echoes it as `X-CSRF-Token` on mutating routes.
- Updates the cached CSRF token on every response that rotates cookies.

## Bearer mode

```ts
const client = createAuthFnClient({
  baseUrl: 'https://api.example.com/auth',
  bearerToken: () => credentialStore.getToken(),
});
```

Pass `bearerToken` as either a string or an async getter. The client:

- Sets `Authorization: Bearer <token>` automatically.
- Sends `credentials: 'omit'`.
- Skips CSRF entirely (bearer mode is not subject to CSRF).
- After successful sign-in / sign-up, set `sessionMode: 'bearer'` in the request body — the kernel will return the bearer token in `data.token`. Hand it to your credential store.

```ts
const result = await client.signInWithPassword({
  email,
  password,
  sessionMode: 'bearer',
});
if (result.ok && result.data.token) {
  credentialStore.setToken(result.data.token);
}
```

## Browser social handoff

`createBrowserHandoff` runs the [handoff code exchange](../plugins/social-oauth#handoff-code-exchange) in a browser app. It keeps the verifier in a store you choose, binds the return to the handoff that started it, and makes the stored state single use.

```ts
import {
  createAuthFnClient,
  createBrowserHandoff,
  createWebStorageHandoffStore,
} from '@authfn/client';

const client = createAuthFnClient({ baseUrl: 'https://api.example.com/auth' });
const handoff = createBrowserHandoff({
  store: createWebStorageHandoffStore(localStorage),
  allowedOrigins: ['https://app.example.com'],
  exchange: client.exchangeSocialHandoff,
});

// Sign-in button
const begun = await handoff.begin({ returnTo: 'https://app.example.com/post-auth' });
const started = await client.startSocialSignIn({ provider: 'google', ...begun.start });
if (started.ok) location.assign(started.data.redirectTo);

// On /post-auth
const result = await handoff.complete(location.href);
if (result.status !== 'not-callback') history.replaceState(null, '', result.cleanUrl);
if (result.status === 'completed') credentialStore.setToken(result.handoff.token);
```

- `begin` creates a random verifier and a handoff id, stores them for `ttlMs` (default 10 minutes), and returns the `/social/start` input. The id travels in the `returnTo` fragment (`#authfn_handoff=<id>`), so the provider's `allowlistedReturnTo` must list the app's bare origin (`https://app.example.com`), not one exact URL. The server must accept a session-token handoff to a web target (`allowWebSessionTokenHandoff`).
- `complete` accepts only a return on an allowed origin, on the origin and path the handoff began on, carrying `handoff=code` for that handoff id. It then claims the stored record, replacing it with a tombstone that no longer holds the verifier, before it calls `exchange`. Any return that names a live handoff uses it up, whatever the outcome; start again after a failure.
- Several windows over one store are concurrent participants. `createWebStorageHandoffStore` claims under `navigator.locks` when the browser has it, so only one window exchanges. Without an atomic claim, both may exchange, and the server's single-use code lets only the first succeed; the other window gets `already-used`.
- `sessionStorage` keeps the handoff to one tab. A custom store implements `get`, `set`, `delete`, `keys` and `compareAndSet`.
- Results, events (`onEvent`) and stored tombstones never contain the verifier or the code. Navigation, removing the callback parameters with `cleanUrl`, and keeping the session token stay with your app.

`complete` returns `{ status: 'completed', session, handoff, requestId, cleanUrl }`, `{ status: 'not-callback' }` for a page without a handoff return, or `{ status: 'failed', reason }`:

| `reason` | Meaning |
|---|---|
| `origin-mismatch` | The return is not on an allowed origin, or not on the one the handoff began on. |
| `flow-mismatch` | The return is not the code-and-verifier return of the handoff it names (another path, no `handoff=code`, or no handoff id). |
| `unknown-handoff` | No handoff with that id is stored here. |
| `expired` | The handoff outlived `ttlMs`. |
| `already-used` | Another window, a reload or a duplicate return already claimed it, or the server reports the code used. |
| `malformed-state` | The stored record could not be read; it is removed. |
| `malformed-callback` | The return's parameters are missing or invalid. |
| `provider-error` | The callback redirected with `auth_error`; `error.code` holds the server's code. |
| `exchange-rejected` | The server refused the code; `error` holds its code and message. |
| `exchange-canceled` | The exchange threw or failed before a response. |

`prune()` removes expired records (`begin` also prunes), and `abandon(handoffId)` removes one that the user gave up on.

## Region-aware client

```ts
import { createAuthFnRegionalClient } from '@authfn/client';

const regional = createAuthFnRegionalClient({
  defaultRegionId: 'us-east-1',
  resolveBaseUrl(regionId) {
    return regionId === 'eu-west-1'
      ? 'https://api.eu.example.com/auth'
      : 'https://api.us.example.com/auth';
  },
});

const prep = await regional.prepareEmailAuth({
  email: 'ada@eu.com',
  flow: 'sign-in',
});
// prep.data.regionId === 'eu-west-1' → use that region's baseUrl
```

The regional client:

- Caches region lookups in `localStorage` (or your custom `AuthFnRegionStorage`).
- Pre-routes by calling `lookupRegion` before sensitive operations.
- Lets you set the active region with `setCurrentRegionId(regionId)`.
- Calls back via `onRegionChanged` whenever a lookup discovers a new region for an email.

See [Plugins → Multi-region](../plugins/multi-region).

## Per-request metrics

```ts
createAuthFnClient({
  baseUrl,
  onRequestMetric(metric) {
    metrics.observe('authfn_request_duration_ms', metric.durationMs, {
      path: metric.path,
      status: metric.status?.toString() ?? 'error',
      ok: String(metric.ok),
    });
  },
});
```

`metric.serverTiming` carries the kernel's `Server-Timing` header (db, cache, lookup) for a per-request breakdown.

## Type-safe envelopes

The client preserves discriminated-union types:

```ts
const result = await client.getSession();
if (result.ok) {
  result.data.session;        // typed as AuthFnSession | null
} else {
  result.error.code;          // typed as the AuthFnErrorCode union (well, string)
}
```

From `@authfn/client` 0.3.0, `AuthFnSession` has `scopes?: string[]`, the scopes the server checks with `requireScopes`. The client only receives user sessions (`getSession` returns `null` for an API-key credential); servers on `authfn` 0.6.0 and later send them with `['*']`, and older servers omit it.

For convenience, the `AuthFnErrorCode` literal type is available from `authfn/core/errors` if you want to narrow further.

## Errors and retries

The client doesn't auto-retry. If you want retries on `retryable: true` errors, wrap the call:

```ts
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const r = await fn();
    if ((r as any).ok) return r;
    if (!(r as any).error?.retryable) return r;
    await new Promise((r) => setTimeout(r, 250 * 2 ** i));
  }
  return await fn();
}

await withRetry(() => client.sendOtp({ email, purpose: 'sign-in' }));
```

## Related

- [Concepts → Sessions](../core-concepts/sessions) — what the cookie / bearer carries.
- [Plugins](../plugins) — every method on the client maps to one or more plugin routes.
- [Frameworks → SvelteKit](../frameworks/sveltekit) — using the client inside SvelteKit.
- [Frameworks → Next.js](../frameworks/nextjs) — in App Router.
