---
title: Security
description: filefn's threat model — what it protects, what it doesn't, and how to harden a deployment.
---

# Security

filefn is a kernel; it inherits some risks from the host stack and adds a small number of its own. This page explains the threat model and the configuration knobs that matter.

## What filefn protects

- **Bytes at rest** — the storage adapter handles encryption (S3 SSE, GCS CMEK, etc.). filefn doesn't add a second encryption layer.
- **Bytes in flight** — TLS termination is the host stack's job. filefn assumes incoming requests are TLS-terminated and signed URLs are HTTPS.
- **Multipart integrity** — every part is etagged; conflicts fail closed. The final SHA-256 (when supported by storage) is recorded in `fileVersions.checksumSha256Base64`.
- **Idempotent retries** — `x-idempotency-key` prevents duplicate sessions from accidental retries by signed-in callers. Anonymous `init` calls are never replayed: a retry gets a new session.
- **Anonymous upload tokens** — `uploadSessionToken` is hashed at rest and short-lived. Stealing the token gives access only for the session TTL and only for that one upload.
- **Visibility** — `private` files require a session or grant. `shared` enforces the same. Share-link tokens are opaque and hashed.
- **CSRF** — for routes that mutate, filefn requires either an `Authorization` header (bearer) or a CSRF-protected cookie. The kernel doesn't ship CSRF middleware itself; it expects the host framework to provide one.
- **Secret redaction** — every log, event, and webhook payload is scrubbed for signed URLs, bearer tokens, and session tokens.

## What filefn does *not* protect against

- **Network-level attacks** — DDoS, TLS termination, load shedding. Use a CDN / WAF in front of filefn.
- **Compromised storage** — if your S3 bucket is publicly writable, filefn can't help.
- **Compromised auth** — filefn calls `auth.resolveSession`. If your session resolver is broken, every protected route is broken.
- **Malicious uploads** — filefn doesn't run virus scans. Pair it with a `Processor` that does — see [Recipes › Virus scanning](../recipes/virus-scanning).
- **DoS through cost** — large uploads hit your storage egress / processing costs even if rate-limited at the request layer. Use [Quotas](../features/quota) to cap per-tenant storage.

## Hardening checklist

### 1. Real auth

`auth.resolveSession` should return a typed `principalId` and `tenantId`. Never bypass with a hard-coded user in production.

```ts
auth: {
  required: true,
  resolveSession: async (request) => {
    const session = await sessions.fromHeaders(request.headers);
    if (!session) return null;
    return { principalId: session.userId, tenantId: session.orgId };
  },
}
```

### Anonymous mode (`auth.required: false`)

Every unauthenticated caller is the same principal, `anonymous`, so FileFn treats an anonymous upload as owned by nobody:

- an unauthenticated caller can upload, but owns nothing: it has no owner's access to what was uploaded (a `public` upload stays readable and listable by anyone; under the default authorizer, a private one needs a read grant made to the principal `anonymous`), it cannot replace or delete it (the default authorizer decides writes and deletes by ownership; only a configured `authorizer` can allow more), and it can never create, list or revoke share links or grants, even with a `canShare` grant;
- the file is readable only through its policy's visibility (`public`), a grant, or a share link that an authenticated user created.

Use anonymous mode for public drop-offs. For uploads people should manage afterwards, configure `auth.resolveSession`.

The principal ID `anonymous` is reserved for this: never return it from `auth.resolveSession` for a real user, who would own nothing. Share links and grants created on anonymous uploads before this rule keep working. Grants can no longer be listed or revoked over HTTP (only an owner manages grants), and share links only by a signed-in user holding a `canShare` grant on the file. Where no such user exists, review them in the database: set `revokedAt` on the `fileShares` rows, and delete the `filePermissions` rows you don't want, whose file is owned by `anonymous`.

### 2. Per-route rate limits

Always configure `rateLimit.limits` in production. Each category is opt-in: one you omit is not limited. The unrestricted defaults are intentional (the kernel doesn't pretend to know your traffic), but they're not safe in the wild.

A public upload deployment (`auth.required: false`) must also set `rateLimit.clientKey` from an address the edge proxy overwrites, such as `cf-connecting-ip` after the proxy strips any client-supplied value. Without it, every guest shares one bucket per category. See [Rate limiting](../features/rate-limiting).

### 3. CORS

Default to a strict origin list. Wide-open `Access-Control-Allow-Origin: *` works for proxy-mode public files, but anything that depends on credentials must scope down.

### Cookie auth and CSRF

Every FileFn route that takes a JSON body accepts only `Content-Type: application/json` (or a `+json` type) and answers anything else with `415 FILEFN_UNSUPPORTED_MEDIA_TYPE`, so a cross-site form or `no-cors` fetch cannot reach it without a CORS preflight. Routes that take raw bytes (upload-part `PUT`s and artifact uploads) are not covered by this check: they need a valid upload session or an authorized caller, so keep cookie auth `SameSite=Lax` or stricter, or check `Origin` in the host, for those too. A `POST` without a body (completing an upload) is still a simple request: when auth is a cookie, set it `SameSite=Lax` or stricter, or check `Origin` in the host. JSON bodies over 64 KiB are refused with `413 FILEFN_BODY_TOO_LARGE`.

### 4. Strict policies

- Upper-bound every policy's `maxSizeBytes`. Don't ship a policy with unlimited size unless you really mean it.
- Lock `contentTypes` — `image/*` is fine; `*/*` is a footgun.

### 5. Storage isolation

If you serve multiple tenants:

- Use per-tenant storage targets (`storageTarget: "tenant-${tenantId}"`).
- Use bucket policies to deny cross-tenant access at the storage layer.
- Use `storagePath` to prefix every object with the tenant id.

### 6. Quota

Configure `quota` to refuse uploads when a tenant approaches their plan limit. The default `QuotaProvider` interface exposes `current`, `limit`, and `requested` so the client can show useful errors.

### 7. Share-link hygiene

- Always set `expiresAt`. Forever-shareable tokens accumulate forever.
- Set `maxDownloads` if the link is meant for one or two recipients.
- Set `requiresAuth: true` for internal-only sharing.
- Show `tokenHashPrefix` (returned by `GET /share-links`) in audit UIs — never the raw token.

### 8. Logger / event sinks

Pipe events and logs to your observability stack. Pair `processing.failed` and high `FILEFN_RATE_LIMITED` rates with alerts.

### 9. Native bridge integrity

For WKWebView apps using `@filefn/swift-bridge`:

- The bridge handshake verifies protocol version (`filefn-bridge/v1`).
- Native-backed mode is fail-fast. Don't fall back to browser-owned uploads if the bridge fails.
- Preview URLs use `filefn-bridge://asset/{handle}/preview`. Never expose filesystem paths to JS.

## Reporting issues

Security issues should go through the [GitHub security advisory](https://github.com/21nCo/super-functions/security/advisories) flow, not the public issue tracker.
