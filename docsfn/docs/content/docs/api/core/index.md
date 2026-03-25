---
title: "@docsfn/core"
description: Framework-agnostic docsfn pipeline — config, manifest, search, compile, and types.
---

# @docsfn/core

Framework-agnostic engine for loading configuration, ingesting content through a **`DocsContentProvider`**, building a **`DocsManifest`**, compiling Markdown, generating search artifacts, and shared security/analytics helpers.

## Installation

```bash
npm install @docsfn/core
```

## Export areas

| Area | Topics |
| --- | --- |
| Config | [Config](./config) — `loadDocsConfig`, defaults, filenames |
| Manifest | [Manifest](./manifest) — `buildManifest`, manifest shape |
| Search | [Search](./search) — `buildSearchIndex`, artifact types |
| Types | [Types](./types) — pages, posts, config, sidebars |
| Navigation | [Navigation](./navigation) — sidebars, breadcrumbs, pagination |
| Routing | [Routing](./routing) — slugs, routes, static param helpers |
| Blog | [Blog](./blog) — canonical blog records |
| Markdown | [Markdown](./markdown) — compile pipelines, block types |
| Security | [Security](./security) — HTML trust, auth gates, redaction |
| Analytics | [Analytics](./analytics) — canonical event types |
| RSS | [RSS](./rss) — `generateRSSFeed` |
| OpenAPI | [OpenAPI](./openapi) — canonical reference model |
| Diagnostics | [Diagnostics](./diagnostics) — `DocsError`, codes |
| Theme | [Theme](./theme) — `ThemeConfig`, CSS vars |
| Helpers | [Helpers](./helpers) — breadcrumb/pagination helpers |

Re-exports also include **`@docsfn/core`** entry points used by CLI and adapters (see package `src/index.ts`).
