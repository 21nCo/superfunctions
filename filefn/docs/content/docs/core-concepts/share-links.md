---
title: Share links
description: Tokenised, optionally auth-required, optionally download-capped public links to files.
---

# Share links

Share links are how filefn exposes a file (or a specific version of it) to recipients who don't have a session. They're:

- **Tokenised** — opaque random tokens, hashed at rest. The plaintext is returned exactly once on creation.
- **Optionally auth-required** — set `requiresAuth: true` to require a session in addition to the token.
- **Optionally TTL'd** — `expiresAt` is enforced server-side.
- **Optionally download-capped** — `maxDownloads` is enforced and incremented atomically per download.

## Routes

- `POST /:fileId/share-links` — create
- `GET /:fileId/share-links` — list (returns `tokenHashPrefix`, never the plaintext)
- `DELETE /:fileId/share-links/:token` — revoke (token is the *plaintext* you got at creation)
- `GET /share-links/:token/download` — resolve to a download URL (signed, or proxy-mode)
- `GET /proxy/share-links/:token/download` — stream the bytes through filefn

## Creating a link

```bash
curl -X POST https://example.com/filefn/file_xyz/share-links \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "expiresAt": "2099-01-31T23:59:59Z",
    "requiresAuth": false,
    "maxDownloads": 10
  }'
```

Response:

```json
{
  "ok": true,
  "data": {
    "token": "shr_live_<random>",
    "url": "https://example.com/filefn/share-links/shr_live_<random>/download",
    "expiresAt": "2099-01-31T23:59:59.000Z",
    "requiresAuth": false,
    "maxDownloads": 10
  }
}
```

The `token` is the plaintext — it appears in this response **only** and is not retrievable later. Store it client-side or hand it directly to the recipient.

## What the recipient sees

```bash
curl https://example.com/filefn/share-links/shr_live_<random>/download
```

Returns a signed URL (or a proxy URL when the storage adapter doesn't sign):

```json
{
  "ok": true,
  "data": {
    "url": "https://cdn.example.com/...?Signature=...",
    "fileName": "report.pdf",
    "mimeType": "application/pdf"
  }
}
```

The recipient `GET`s the `url` to actually fetch the bytes. The download counter increments **on this resolve call**, not on the actual byte transfer. This makes the cap easy to reason about; you cap "presented offers," not "completed transfers."

## Revoking

```bash
curl -X DELETE https://example.com/filefn/file_xyz/share-links/shr_live_<random> \
  -H "Authorization: Bearer $TOKEN"
```

After revoke, the token returns `FILEFN_SHARE_REVOKED` (HTTP 410).

## Errors

| Error code | When |
| --- | --- |
| `FILEFN_SHARE_NOT_FOUND` | The token doesn't match any row. |
| `FILEFN_SHARE_EXPIRED` | The current time is past `expiresAt`. |
| `FILEFN_SHARE_REVOKED` | The token was revoked. |
| `FILEFN_SHARE_DOWNLOADS_EXCEEDED` | `maxDownloads` was reached. |
| `FILEFN_SHARE_DOWNLOAD_CONFLICT` | Too many concurrent downloads of the link; retry. |

All return HTTP 410 except `NOT_FOUND` (404) and `SHARE_DOWNLOAD_CONFLICT` (409). Retry a 409, treat a 410 as final, and read a 404 as no matching link. A token that matches no link gets 404 (once the request is past the rate limit, which answers 429 first), never one of the 410s, so trying tokens reveals nothing about links that exist.

## What share links don't do

- They don't grant write or delete. They're read-only.
- They don't replace grants. Use grants for known-principal access; use share links for anonymous-or-link-driven access.
- They don't bypass policies. `visibility: "public"` files have direct download URLs already; you don't need a share link for those.

## Storage cost

Each link is a row in `fileShares`. `maxDownloads`, `downloads`, and `revokedAt` are mutable fields; nothing else is. Revoked links are kept (with `revokedAt` set) so you have an audit trail. Operators that want hard delete should run their own purge job.
