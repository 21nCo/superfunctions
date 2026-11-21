---
title: Rate limiting
description: What authfn does and doesn't enforce, and how to add the limits you need.
---

# Rate limiting

authfn can enforce per-route limits through `createServer({ rateLimit })`. You should still put a limiter at the edge of your platform — a CDN, a WAF, a gateway — where it can deny traffic before any application code runs.

```ts
authApp.createServer({
  database,
  rateLimit: {
    enabled: true,
    mode: 'local', // 'strict' | 'best-effort' | 'local'
    // Safe only when Cloudflare removes client-supplied copies of this header.
    resolveClientIp: (request) => request.headers.get('cf-connecting-ip') ?? undefined,
    policies: {
      password: { ipLimit: 10, windowSeconds: 60 },
      'otp-send': { ipLimit: 5, windowSeconds: 60 },
    },
  },
});
```

Use `strict` with an atomic store, `best-effort` with a shared cache, or `local` for process-local protection. `resolveClientIp` must read a trusted platform or proxy context — forwarding headers are ignored unless you parse them there.

This page also documents the logical replay protections the kernel already enforces, and how to add extra limits with middleware or hooks.

## What authfn already enforces

A handful of routes have built-in protections that aren't traditional rate limits but serve a similar purpose:

- **OTP attempt counter.** Each OTP challenge tracks `attemptCount`. After a small number of failed verifications (per the plugin's config), the challenge is invalidated.
- **Per-email OTP budget** (TypeScript kernel). Wrong codes and new challenges are also counted per email across all challenges and purposes (by default 10 wrong codes and 20 challenges per hour). Requesting a new code does not reset the count. This is stored with the challenges, so it applies whether or not the HTTP rate limiter is enabled. Because the budget belongs to the email, anyone who knows an address can use it up and block that address's OTP sign-in and password reset until the window passes; enable the HTTP rate limiter as well, so a single client cannot do this cheaply. The Python port does not enforce this budget yet, only the per-challenge counter, and it has no `rateLimit` setting: a Python deployment must throttle OTP sends and verifications itself (at the edge, or in middleware in front of the AuthFn routes). Python skips challenges the TypeScript kernel refused, but the two kernels do not otherwise share OTP challenges: they hash codes differently (Python's email-OTP plugin uses PBKDF2, TypeScript SHA-256), so a code sent by one kernel is not accepted by the other.
- **OAuth state replay.** OAuth states are one-shot. Replaying the same state returns `AUTHFN_OAUTH_STATE_REPLAYED` and the request is rejected without further processing.
- **Native handoff codes.** One-time, short TTL.
- **Two-factor attempts.** When `rateLimit` is enabled, `/2fa/challenge`, `/2fa/confirm` and `/2fa/disable` use the `two-factor` policy: 30 requests per IP and 5 per challenge ID (for `/2fa/challenge`) or per session cookie (for `/2fa/confirm` and `/2fa/disable`, which only accept cookie sessions); challenge ids are trimmed and lower-cased before counting in a 5-minute window by default. Other body fields do not change the counter.

These protect against logical replay attacks but do not protect against high-volume probing or credential stuffing.

## What you should rate-limit

The following routes are sensitive enough to want explicit limits:

| Route | Limit by | Rationale |
| --- | --- | --- |
| `POST /auth/sign-in/password` | IP + email | Credential stuffing, brute force. |
| `POST /auth/sign-up/password` | IP | Mass account creation. |
| `POST /auth/otp/start` | IP + email | OTP-bombing attacks against a victim's inbox. |
| `POST /auth/oauth/:provider/start` | IP | Provider-side abuse / quota burn. |
| `POST /auth/2fa/challenge` | IP + user | Brute force on the second factor. |
| `POST /auth/api-keys` | IP + user | Mass key creation. |
| `DELETE /auth/account` | IP + user | Repeated cascade-delete abuse. |
| `POST /auth/password/reset/start` | IP + email | Reset-link spam. |

## How to enforce limits

Three good options, in increasing order of integration with authfn:

### Option 1: Edge-layer limiter

Cloudflare WAF rate limit rules, AWS WAF, fastly, your reverse proxy. Match on path, source IP, and for some routes a JSON-body field (`email`). This is the lowest-overhead option and works regardless of how authfn is deployed.

### Option 2: Middleware in front of authfn

Wrap your framework's authfn mount with a rate-limiting middleware. With Hono, for example:

```ts
import { rateLimiter } from 'hono-rate-limiter';

app.use('/auth/sign-in/*', rateLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (c) => `${c.req.header('x-forwarded-for')}:${c.req.path}`,
}));

app.route('/auth', toHono(auth.router));
```

When the limit is exceeded, return a 429 with `Retry-After`. The first-party SDKs surface `AUTHFN_RATE_LIMITED` whether the kernel or your middleware emits it.

### Option 3: Custom plugin or hook

If your limiter needs to know about plugin-specific context (e.g. the resolved `userId` after sign-in), use a `before*` hook to enforce a per-actor limit:

```ts
import { AuthFnRateLimitedError } from 'authfn';

authApp.createServer({
  database,
  hooks: {
    async beforeSessionIssue(ctx, input) {
      const ok = await limiter.consume(`session:${input.userId}`, 5, 60_000);
      if (!ok) {
        throw new AuthFnRateLimitedError('Too many sign-ins; try again in a minute', {
          retryAfterMs: 30_000,
        });
      }
    },
  },
});
```

The kernel will translate the throw into a `429 AUTHFN_RATE_LIMITED` envelope with `details.retryAfterMs` carried through.

## How clients should behave

`@authfn/client`, the Python SDK, and `AuthFnSwift` all handle `AUTHFN_RATE_LIMITED` by:

1. Reading `details.retryAfterMs` if present.
2. Surfacing a typed `AuthFnError` (or its language equivalent) with `code === 'AUTHFN_RATE_LIMITED'`.
3. Letting the caller decide whether to back off and retry.

Show the user a "wait a minute and try again" message; don't auto-retry on the user's behalf without a backoff strategy.

## Multi-region and rate limiting

If you're multi-region and want a shared global limit (so that a credential-stuffing campaign hitting both `api.us` and `api.eu` is throttled in aggregate), use a globally-replicated counter store: Cloudflare D1 with replicas, AWS DynamoDB Global Tables, Redis with cross-region streams. Per-region limits without cross-region awareness are easier but won't catch a coordinated attacker.

## Observability

Every `429` response emits `authfn.rate_limited`. The event carries `metadata` with the route, the limiter that fired, and any `retryAfterMs`.

## Related

- [Errors](./errors) — `AUTHFN_RATE_LIMITED`.
- [Observability](./observability) — `authfn.rate_limited` event.
- [Security](./security) — full threat model.
- [Hooks](./hooks) — `beforeSessionIssue` and others.
