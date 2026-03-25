---
title: Search
description: Configure docsfn search scopes, body indexing, artifacts, and the DocsSearch UI.
---

# Search

docsfn builds a **search artifact** (`DocsSearchArtifact`) at compile time and serves it as JSON. The browser loads that artifact (or fetches it lazily) and runs queries through **searchfn**’s in-memory engine.

See also: [Configuration](./configuration), [CLI](./cli), [Content providers](./content-providers).

## Enabling search

In **`docsfn.config.ts`**:

```ts
search: {
  enabled: true,
  scopes: ["docs", "api", "blog"],
  bodyIndexing: "summary",
  maxArtifactBytes: 1_500_000,
},
```

- **`enabled`**: When `false`, the pipeline skips emitting `search.json` in CLI artifact writes (and you should avoid exposing an empty endpoint).

## Scopes: `docs`, `api`, `blog`

Each indexed document carries a **`scope`** (`DocsSearchScope`). The runtime can filter results:

- **`docs`** — documentation pages.
- **`api`** — API reference entries derived from OpenAPI (and related sources).
- **`blog`** — blog posts.

`DocsSearch` defaults to scope filters **`["all", "docs", "api", "blog"]`**. Pass a narrower `scopes` prop if your site disables some collections.

## Body indexing modes

`search.bodyIndexing` controls how much text is indexed per page/post:

| Mode | Behavior |
| --- | --- |
| `"full"` | Indexes the **entire** Markdown body (largest artifacts, best recall on long pages). |
| `"summary"` | Indexes a **short plain-text summary** (default helper uses roughly the first **220** characters of normalized body text when no description/excerpt exists). |
| `"disabled"` | Title and metadata only; minimal artifact size. |

### Trade-offs

- **`full`** improves matching inside long prose but **increases JSON size** and parse/hydrate cost in the browser.
- **`summary`** balances size and quality for typical docs sites.
- **`disabled`** is ideal when you only need title/path search.

## `maxArtifactBytes`

If the serialized artifact size exceeds **`search.maxArtifactBytes`**, the build fails with a diagnostic (`DOCS_SEARCH_BUILD_FAILED`). Use this as a **guardrail** in CI when enabling `full` body indexing or very large corpora.

## Serving the artifact in SvelteKit

Expose a route that returns the JSON artifact with `createSearchArtifactResponse` from **`@docsfn/sveltekit`**:

```ts
// src/routes/search.json/+server.ts
import { createSearchArtifactResponse } from "@docsfn/sveltekit";

export const GET = async ({ locals }) => {
  const source = await locals.getDocsSource(); // your app’s helper
  return createSearchArtifactResponse({ artifact: source.searchArtifact });
};
```

The helper sets JSON headers and serializes the artifact your layout/build already produced.

## `DocsSearch` component

From **`@docsfn/svelte`**:

- Pass **`searchArtifact`** or **`loadSearchArtifact`** for lazy loading.
- **`placeholder`**, **`initialScope`**, and **`scopes`** tune the dialog.
- Optional **`analytics`** hooks into `maybeEmitAnalyticsEvent` from core.

### Keyboard shortcut: Cmd / Ctrl + K

`DocsSearch` registers **`Meta+K` / `Ctrl+K`** globally to open the dialog (see `onMount` in `DocsSearch.svelte`).

### Scope filtering

The dialog UI lets users restrict queries to **All**, **docs**, **api**, or **blog**; the runtime passes the selected scope into **`createDocsSearchRuntime`’s `query()`**.

## How scoring works (brief)

The artifact embeds a **searchfn** snapshot. At query time, core wraps **`InMemorySearchFn`**, which applies **BM25-style full-text scoring** (term frequency / inverse document frequency) over the indexed fields, then sorts by **score**, **title**, and **path** for stable ordering.

You do not configure BM25 weights in `docsfn.config.ts`; tuning is achieved by **scope**, **body indexing mode**, and content structure.
