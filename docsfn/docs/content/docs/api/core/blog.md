---
title: core — Blog
description: Blog canonicalization types and buildCanonicalBlogRecords in @docsfn/core.
---

# Blog (`@docsfn/core`)

## `buildCanonicalBlogRecords(input)`

**`BuildCanonicalBlogRecordsInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `posts` | `NormalizedPostRecord[]` | Normalized blog sources from manifest pipeline. |
| `basePath?` | `string` | Defaults to `/docs` normalization for list routes. |
| `preview?` | `boolean` | When true, **draft** posts are retained. |
| `pageSize?` | `number` | Archive size (minimum **1**, default **10**). |

**Returns:** `CanonicalBlogBuildResult` — `{ posts, listRoute, feedPath, postOrder, tags, archives }` (plus the posts array matches **`BlogPost`** shape).

## `BlogManifestSurface`

| Field | Description |
| --- | --- |
| `listRoute` | Blog index path. |
| `feedPath` | RSS path suffix used by **`generateRSSFeed`**. |
| `postOrder` | Ordered post ids (newest first). |
| `tags` | Map tag label → **`BlogTagIndex`**. |
| `archives` | `BlogArchivePage[]` pagination descriptors. |

## `BlogTagIndex` / `BlogArchivePage`

See **`types.ts`** — include `path`, `slug`, `postIds`, and archive `page` / `totalPages` / `pageSize`.

## Helpers

- **`assertValidBlogPublishMetadata(post)`** — validates date fields.
- **`resolveBlogLastBuildDate(posts)`** — RSS **`lastBuildDate`**.
