---
title: core — Types
description: Primary TypeScript types exported from @docsfn/core.
---

# Types (`@docsfn/core`)

## Content models

| Type | Purpose |
| --- | --- |
| **`DocPage`** | Docs collection page: `id`, `slug`, `path`, `title`, `body`, `headings`, `frontmatter`, optional `version`. |
| **`BlogPost`** | Blog entry: `slug`, `path`, `title`, `date`, `tags`, `draft`, `excerpt`/`summary`, etc. |
| **`ApiReference`** | API entry: `path`, `title`, `spec` (canonical OpenAPI object), `frontmatter`. |
| **`DocHeading`** | TOC node: level, text, slug. |

## Provider / source

| Type | Purpose |
| --- | --- |
| **`DocsSourceEntry`** | Normalized file row from a provider (`id`, `collection`, `relativePath`, `body`, `frontmatter`, …). |
| **`DocsContentProvider`** | Interface: `listEntries`, `loadEntry`, optional `loadAsset` / `watch`, legacy **`list()`**. |

## Navigation

| Type | Purpose |
| --- | --- |
| **`SidebarItem`** | `type`: `link` \| `group` \| `separator`; text; optional `link`, `items`, `collapsed`. |
| **`Sidebar`** | `id` + `items[]`. |
| **`DocsTopNavItem`** | Top nav node with optional nested **`children`**. |

## Config

| Type | Purpose |
| --- | --- |
| **`DocsConfig`** | Root config (`schemaVersion: 1`, `site`, `content`, `navigation`, `search`, `auth`, `analytics`, …). Full field list: **[Config](./config)** + **[Configuration](../../core-concepts/configuration)**. |
| **`DocsCompatPreset`** | `"none"` \| `"fumadocs-v15"`. |

## Errors

**`DocsErrorCode`** — string union of all **`DOCS_*`** codes (see **[Diagnostics](./diagnostics)**).

**`DocsDiagnostic`** — `code`, `severity`, `message`, optional `location`, `details`, `suggestion`.
