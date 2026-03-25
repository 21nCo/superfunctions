---
title: "@docsfn/provider-fs"
description: Filesystem DocsContentProvider for docsfn.
---

# @docsfn/provider-fs

## `FsContentProvider`

### Constructor

```ts
new FsContentProvider({
  root: string;
  docsDir?: string;
  pagesDir?: string;
  blogDir?: string;
  apiDir?: string;
  assetsDir?: string;
})
```

Paths in **`FsProviderOptions`** override config defaults when passed from your bootstrap (CLI mirrors **`DocsConfig.content`** into these fields).

### `DocsContentProvider` methods

| Method | Description |
| --- | --- |
| **`listEntries({ config, collections })`** | Walks configured directories with **fast-glob** `**/*`, returns **`DocsSourceEntry[]`**. |
| **`loadEntry({ config, entry })`** | Identity pass-through for FS (entry already hydrated). |
| **`loadAsset({ config, relativePath })`** | Reads bytes from assets root, returns length + sha256. |
| **`watch({ config, onChange })`** | Returns subscription metadata for watched dirs (CLI dev uses metadata paths). |
| **`list()`** | Legacy: loads default collections and maps to **`RawContentEntry[]`**. |

### Collection directory resolution

Relative to **`config.content.root`** (or `options.root`):

| Collection | Config key | Default candidates |
| --- | --- | --- |
| docs | `content.docsDir` | `content/docs`, `docs` |
| pages | `content.pagesDir` | `pages` |
| blog | `content.blogDir` | `blog` |
| api | `content.apiDir` | `api` |
| assets | `content.assetsDir` | `public`, `assets` |

### File types

- Markdown **`.md` / `.mdx`** — docs, pages, blog.
- **`.json` / `.yaml` / `.yml`** — api collection (OpenAPI).
- **`meta.json`** (or `metaFileName`) — control files.
- **Assets** — opaque binary/text files.

## `DocsContentProvider` interface (core)

Defined in **`@docsfn/core`**: `providerId`, `listEntries`, `loadEntry`, optional `loadAsset` / `watch`, and legacy **`list()`**.
