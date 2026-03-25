---
title: "@docsfn/svelte — Components"
description: Props and behavior for docsfn Svelte UI components.
---

# Components (`@docsfn/svelte`)

Types **`DocsPageSurface`**, **`DocsPageLink`**, etc., are defined alongside **`DocsLayout.svelte`** and re-exported from the package.

## DocsLayout

**Props:** `surface?`, `sidebar?`, `headings?`, `activePath?`.

**Slots:**

- **`topbar`** — place **`TopBar`** or branding.
- **Default slot** — main page content.

Renders **`DocsSidebar`** when a sidebar resolves, and **`DocsToc`** when headings exist.

## DocsContent

**Props:** `compiled?`, `content` (raw Markdown), `sourcePath?`, **`compatPreset`** (default `none`), **`allowUnsafeHtml`**, **`unsafeHtmlAllowlist`**, **`components`** map (PascalCase tag → Svelte component).

**Slots:** **`page-actions`** — rendered after blocks inside **`data-docsfn-page-actions`**.

Trust: when `compiled` is passed, runs **`assertCompiledContentTrusted`** against transformed source.

## DocsSidebar

**Props:** `surface?`, `sidebar?`, `activePath?`, **`defaultCollapsedGroups`** (group labels to start collapsed).

## SidebarGroup

**Props:** **`item`** (`SidebarItem`), **`activePath?`**, **`defaultCollapsed`**, **`depth`** (internal recursion).

Renders collapsible groups, separators (`hr`), and active link states (`aria-current`).

## DocsToc

**Props:** `surface?`, `headings?`, **`activeHash?`**.

When **`activeHash`** is unset, mounts **IntersectionObserver** to highlight the visible heading.

## DocsSearch

**Props:** `searchArtifact?`, **`searchIndex`** (alias), **`loadSearchArtifact?`**, `placeholder`, **`initialScope`**, **`scopes`**, **`analytics`** (`enabled`, `respectDnt`, `route`, `onEvent`).

**Behavior:** Global **Cmd/Ctrl+K** opens dialog; scope filters map to runtime scopes; results navigate via full page load by default.

## TopBar

**Props:** `surface?`, **`logo`**, **`items`** (override nav), **`searchTrigger`**, **`versionSelector`**, **`mobileMenuTrigger`** (each a component constructor).

Derives **`items`** from **`surface.topNav`** when omitted.

## Pagination

**Props:** `surface?`, **`prevPage`**, **`nextPage`**, **`sectionContext`**.

**Keyboard:** **Alt+ArrowLeft** / **Alt+ArrowRight** when prev/next exist.

## Breadcrumbs

**Props:** `surface?`, **`items`** (explicit `{ label, href? }[]`), **`separator`** (component).

## VersionSwitcher

**Props:** `surface?`, **`versions`**, **`currentVersion`**, **`onVersionChange`**.

Default navigation uses **`surface.versionLinks`** or regex rewrite of the first version path segment.

## EmbeddedPage

**Props:** `title`, `description?`, `content`, `headings`, `compiled?`, **`compatPreset`**, **`components`**, **`showToc`**, **`tocLabel`**.

Delegates body rendering to **`DocsContent`**.

## ApiReferenceRenderer

**Props:** **`api`** (`ApiReference`).

Renders operations, parameters, and responses from **`api.spec`** (**`CanonicalOpenApiReference`**).
