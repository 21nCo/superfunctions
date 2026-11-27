---
title: Share links
description: Opt-in tokenised, optionally auth-required, optionally download-capped public links to files.
---

# Share links

See [Core Concepts › Share links](../core-concepts/share-links) for the full lifecycle. This page is the operator-facing reference.

## Enabling

Share links are on by default. Configure them with `shares` in `createFileFn`:

```ts
createFileFn({
  // ...
  shares: {
    enabled: true,         // false removes every share-link route (not fileFn.services.shares)
    requireAuth: false,    // true: every new link needs a signed-in downloader
    maxTtlSeconds: 86_400, // cap on a link's lifetime (at most 100 years); also the lifetime of a link created without expiresAt
  },
});
```

Without `maxTtlSeconds`, a link created without `expiresAt` never expires.

`enabled: false` removes the HTTP routes only. `fileFn.services.shares` (and the admin app, which uses it) can still create, list and revoke links, and links stored meanwhile work again once the routes are back.

## Routes

- `POST /:fileId/share-links` — create
- `GET /:fileId/share-links` — list (returns hash prefix only)
- `DELETE /:fileId/share-links/:token` — revoke
- `GET /share-links/:token/download` — resolve to a download URL
- `GET /proxy/share-links/:token/download` — proxy-mode download

## Schema

`fileShares`:

```ts
interface FileShareRecord {
  tokenHash: string;
  fileId: string;
  versionId?: string;
  expiresAt?: string;
  requiresAuth: boolean;
  maxDownloads?: number;
  downloads: number;
  createdAt: string;
  revokedAt?: string;
}
```

`tokenHash` is a hash of the plaintext token. The plaintext is returned exactly once on creation.

## Authorization

To create a share link, the principal must own the file (or have a grant with `canShare: true`). To revoke, the principal must own the file or have created the share link.

Anonymous downloads (no auth) work when `requiresAuth` is `false`. If `requiresAuth: true`, the recipient must present a valid session in addition to the token.

## TTL and download caps

Both fields are server-enforced and checked when the link is created: `expiresAt` must be an ISO 8601 date (`2030-01-01`) or date-time (`2030-01-01T00:00:00Z`; without a zone it is read as UTC) in the future, and `maxDownloads` a positive integer, otherwise the request fails with `FILEFN_INVALID_REQUEST`. An empty `expiresAt` means no expiry. A stored `expiresAt` in any other format counts as expired. Each download is counted with a conditional write before any byte or URL is handed out, so concurrent downloads never exceed `maxDownloads`; the extra requests fail with `FILEFN_SHARE_DOWNLOADS_EXCEEDED`. A download that keeps losing that write to concurrent ones fails with `FILEFN_SHARE_DOWNLOAD_CONFLICT` (409, retryable). A proxied download opens its stream before it is counted (and hands it out only if the link is still valid after counting), and a signed one gives its count back if signing fails, so a storage failure never uses up a download. A signed download URL is signed right after the download is counted, with the server's signed-URL TTL or the whole seconds left before `expiresAt`, whichever is shorter, so it ends no later than the link (give or take the time the storage takes to sign). With less than a second left the TypeScript server names the proxy URL instead, which checks the link again when it is fetched; on storage that can only sign URLs, and on the Python server whenever it can sign, the link counts as expired then.

## Anti-enumeration

`FILEFN_SHARE_NOT_FOUND` (404) and `FILEFN_SHARE_REVOKED` / `FILEFN_SHARE_EXPIRED` (410) are deliberately distinct. The 404 means "no row." The 410s mean "row exists but unusable." This is the only place where the kernel leaks any signal — if you want to fully hide existence, set up a CDN-edge handler that returns 404 for both.

## See also

- [Recipes › Signed share links](../recipes/signed-share-links) — common patterns (one-time, time-bound, IP-restricted).
