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
  createIndexedDbHandoffStore,
} from '@authfn/client';

const client = createAuthFnClient({ baseUrl: 'https://api.example.com/auth' });
const handoff = createBrowserHandoff({
  store: createIndexedDbHandoffStore(),
  allowedOrigins: ['https://app.example.com'],
  exchange: client.exchangeSocialHandoff,
});

// Sign-in button
const begun = await handoff.begin({ returnTo: 'https://app.example.com/post-auth' });
const started = await client.startSocialSignIn({ provider: 'google', ...begun.start });
if (started.ok) location.assign(started.data.redirectTo);

// On /post-auth
const result = await handoff.complete(location.href);
if (result.status !== 'not-callback' && result.cleanUrl) history.replaceState(null, '', result.cleanUrl);
if (result.status === 'completed') credentialStore.setToken(result.handoff.token);
if (result.status === 'two-factor-required') askForSecondFactor(result.challengeId, result.primaryMethod);
```

- `begin` creates a random verifier and a handoff id, stores them for `ttlMs` (default 10 minutes, at most 60), and returns the `/social/start` input. `returnTo` must be an `http(s)` URL on an allowed origin, without a fragment or the callback's own query parameters (`auth_error*`, `authfnCode`, `challengeId`, `primaryMethod`). The id travels in the `returnTo` fragment (`#authfn_handoff=<id>`), so the provider's `allowlistedReturnTo` must list the app's bare origin (`https://app.example.com`), not one exact URL. The server must accept a session-token handoff to a web target (`allowWebSessionTokenHandoff`). `begin` needs Web Crypto (`crypto.getRandomValues` and `crypto.subtle`), which browsers provide only in secure contexts (`https`, or `http` on `localhost`); elsewhere it throws before storing anything.
- `complete` accepts only a return on an allowed origin, on the origin and path the handoff began on, carrying `handoff=code` for that handoff id. In a browser it also requires the page's own origin (`location.origin`) to be the callback's origin, and refuses before reading the store otherwise. A return on another origin than the handoff's changes nothing in the store, even when the handoff has expired, the store cannot claim atomically, or the first read failed and a second read finds it, so the return on the right origin still works. It then claims the stored record, replacing it with a tombstone that no longer holds the verifier, and checks the expiry again before it calls `exchange`. Any return that names a live handoff uses it up, whatever the outcome; start again after a failure.
- Several windows over one store are concurrent participants, and one begun handoff completes at most once, even when a retried `/social/start` minted a second code. The claim must therefore be atomic across windows: the server consumes each code once, not each handoff. `createIndexedDbHandoffStore` keeps records in an IndexedDB database of the origin and claims in one readwrite transaction, which the browser runs one at a time across every tab, popup and renderer process of the origin. Without IndexedDB the store reports `atomic: false`, `begin` throws, and `complete` returns `store-not-atomic` without exchanging; use another sign-in path there.
- Web Storage is not a safe store: a popup gets its own copy of the opener's `sessionStorage`, and `localStorage` reaches other processes asynchronously, so neither can claim atomically, even under `navigator.locks`. A custom store implements `get`, `set`, `delete`, `keys` and a `compareAndSet` that is atomic across all participants, and declares `atomic: true`; a store with any other `atomic` value, or none, is refused like `atomic: false`. `createMemoryHandoffStore` is atomic only within one page and does not survive a reload. Both bundled stores declare `originScoped: true`: they hold records for the page's origin only, so with several allowed origins `begin` throws when `returnTo` is on another origin than the page's (`location.origin`), whose return could never find the record. A custom store shared across origins leaves `originScoped` unset.
- When the user has two-factor authentication, the callback issues no code: it returns `?authfnCode=AUTHFN_2FA_REQUIRED&challengeId=…&primaryMethod=…`. `primaryMethod` is one of `oauth-google`, `oauth-apple` and `oauth-github`; any other return is `malformed-callback`. `complete` retires the handoff and returns `{ status: 'two-factor-required', challengeId, primaryMethod, regionId?, cleanUrl }`; continue with `client.completeTwoFactorChallenge({ challengeId, code })`.
- With the region-aware client, read the region once (`const regionId = regional.getCurrentRegionId()`), pass it to `begin` (a region id is 1 to 255 characters with no control characters and no leading or trailing whitespace, such as `aws:eu-west-1`), and start the sign-in through a client of that region (`createAuthFnClient({ ...clientOptions, baseUrl: resolveBaseUrl(regionId) }).startSocialSignIn(...)`) rather than through `regional`, so a region change while `begin` runs cannot start in one region and exchange in another. Use `exchange: createRegionalHandoffExchange({ regionalClient: regional, resolveBaseUrl, clientOptions })` with the same `resolveBaseUrl` and `clientOptions` you gave `createAuthFnRegionalClient`. The region is stored with the handoff, so the exchange reaches the region that issued the code even though the page after the redirect starts in the default region. Each exchange goes through a client of its own region and does not change which region other calls use while it runs; once the exchange returns a session, `regional` moves to that region. A two-factor result carries the stored `regionId`, because the challenge exists only there: call `regional.setCurrentRegionId(result.regionId)` before `regional.completeTwoFactorChallenge(...)`. The `regionId` in the callback URL is never used for routing.
- Results other than `cleanUrl`, events (`onEvent`) and stored tombstones never contain the verifier or the code. `cleanUrl` removes the handoff's own parameters by name (`authfn_handoff`, `token`, `handoff`, `regionId` in the fragment and the server's callback query parameters) and leaves every other parameter as the URL has it, so a copy under another name stays. Failure messages are fixed text, never the exchange's own message. `client.exchangeSocialHandoff` serializes its body once, before anything is awaited, and reports only an allowlisted shape, because a fetch adapter or proxy can reflect the request into errors, headers or bodies. Its `onRequestMetric` metric holds `method`, `path`, `url`, `status`, `ok` and `durationMs`, plus `requestId` and the account fields only when each matches its expected form (an id, a number, a region or colo name) and shares no run of 8 characters with the code or verifier, as written or percent-decoded (up to three times); `serverTiming` is never reported, and a fetch failure is the fixed `AuthFnTransportError` name and message. An error envelope holds the server's error code when it is an `AUTHFN_…`-style code, the fixed message `AuthFn request failed (<status>)` (or `AuthFn request failed before a response was received`), `details: { status }` and a request id under the same rule (else `authfn-redacted`); no response text, error message, stack or cause. Four codes also keep the details current hosts act on, each only when it has its form and shares no such run with the code or verifier: `AUTHFN_REGION_MISMATCH` keeps `regionId` (a region id), `authority` and `redirectTo` (absolute `http(s)` URLs of at most 2048 characters, without credentials) and `continueLocally` (a boolean); `AUTHFN_REDIRECT_REQUIRES_NAVIGATION` keeps `redirectTo` (such a URL, or a root-relative path that starts with one `/`); `AUTHFN_RATE_LIMITED` keeps `resetAt` (an ISO-8601 date and time with a zone, on a date that exists); `AUTHFN_VALIDATION_ERROR` keeps `field` when it is `code`, `verifier` or `userId`. A URL detail is also dropped when the URL as `new URL` rebuilds it shares such a run, or when its hostname (lowercased and IDNA-mapped, so upper case, fullwidth letters or a soft hyphen cannot hide a secret) shares one with the lowercased code or verifier. Every other detail is dropped. An error code or `field` that is exactly one of the client's fixed labels (the codes the client builds, such as `AUTHFN_NETWORK_ERROR`, `AUTHFN_INTERNAL_ERROR`, `AUTHFN_REDIRECT_REQUIRES_NAVIGATION` and `AUTHFN_OAUTH_CALLBACK_FAILED`, the codes the exchange documents, and the field names `code`, `verifier` and `userId`) is that label, so it is kept even when the code or verifier contains it. A success envelope is passed on unchanged unless a string anywhere in it, other than its request id, shares such a run with the code or verifier; it then becomes the `AUTHFN_INTERNAL_ERROR` error envelope above. A response whose body cannot be read (for example an aborted stream) is `AUTHFN_NETWORK_ERROR`, retryable, with the fixed transport message and `details: { status }`. Metrics and envelopes of other requests are unchanged.
- Store failures never leak store text: every store call that throws or rejects becomes `AuthFnBrowserHandoffStorageError` with a fixed message and no cause. `begin` throws it (after retiring a write that may have committed), `prune` and `abandon` throw it only when they cannot proceed, and `complete` returns a typed failure instead.
- A record is retired by one rule, in this order of priority: at most one exchange, then no verifier left behind, then a later return still reading `already-used`. The record is replaced by a tombstone with compare-and-set. If the store throws, or the record could not be read, it is read again: a tombstone another window committed is left exactly as it is (this return reports `already-used`), and anything else is replaced with compare-and-set. Only if that re-read or its compare-and-set fails is the tombstone written plainly, and only if that write throws too is the record deleted, and then a later return reads `unknown-handoff`. A window whose claim fails never exchanges. Navigation, removing the callback parameters with `cleanUrl`, and keeping the session token stay with your app.

`complete` returns `{ status: 'completed', session, handoff, requestId, cleanUrl }`, `{ status: 'two-factor-required', … }`, `{ status: 'not-callback' }` for a page without a handoff return, or `{ status: 'failed', reason }`. A failed result has `cleanUrl` whenever the callback URL could be parsed:

| `reason` | Meaning |
|---|---|
| `origin-mismatch` | The return is not on an allowed origin, or not on the one the handoff began on. |
| `flow-mismatch` | The return is not the code-and-verifier return of the handoff it names (another path, no `handoff=code`, or no handoff id). |
| `unknown-handoff` | No handoff with that id is stored here. |
| `expired` | The handoff outlived `ttlMs`. If another window retired it first, the return reports `already-used`. Every stored record carries the time it was written (`issuedAt`), and a record is malformed only by its own content (a lifetime over 60 minutes from `issuedAt`), so a clock that steps back never retires a live handoff. |
| `already-used` | Another window, a reload or a duplicate return already claimed it, or the server reports the code used. |
| `malformed-state` | The stored record could not be read (including a pending record whose origin is not a canonical `http(s)` origin or whose lifetime is not at least 1 ms), or the store failed; the record is retired to a tombstone (deleted only if the store cannot write), and a tombstone another window committed is kept (that return reports `already-used` when the store can tell). |
| `malformed-callback` | The return's parameters are missing or invalid. |
| `provider-error` | The callback redirected with `auth_error`; `error.code` holds the server's code. |
| `exchange-rejected` | The server refused the code (`error.code` holds its code), or answered with a success that is not a session as the server issues one: a `session` of type `session` with a non-blank `id` and `actorId`, `actorType` `user`, a `subject` with the same `actorId` and `actorType` `user`, and `resourceIds` and `methods` arrays; a `handoff` object of type `session-token` with a non-blank `token`, `sessionId` equal to `session.id`, and `regionId` and `expiresAt` each a string or `null`. A success in which any string but the request id repeats 8 characters of the code or verifier is refused the same way, including from a custom `exchange`. The regional exchange moves the client only for a session `complete` accepts. |
| `exchange-canceled` | The exchange threw, failed before a response, or its response body could not be read. |
| `store-not-atomic` | The store cannot claim atomically across windows; nothing was exchanged, and the handoff is retired where the store can reach it. |

`prune()` retires expired or malformed records and removes expired tombstones (`begin` also prunes); it returns how many it confirmed, and leaves a record the store fails on. It looks only at keys made of its `keyPrefix` and a handoff id, so another instance with a nested prefix (for example `authfn.handoff.admin.`) on the same store keeps its records. `abandon(handoffId)` retires one that the user gave up on.

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
