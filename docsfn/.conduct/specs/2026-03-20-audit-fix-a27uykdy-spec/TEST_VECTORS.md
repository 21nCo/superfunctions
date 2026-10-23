# TEST VECTORS

## TV-CFG-001

- Description: Config validation accepts a complete canonical config and rejects an invalid one.
- Input:
  ```json
  {
    "cwd": "/repo/datafn/docs",
    "config": {
      "schemaVersion": 1,
      "site": {
        "title": "DataFn Docs",
        "basePath": "/docs",
        "canonicalUrl": "https://example.com"
      },
      "compat": { "preset": "fumadocs-v15" },
      "content": {
        "root": "/repo/datafn/docs",
        "docsDir": "content/docs",
        "blogDir": "blog",
        "apiDir": "api"
      },
      "search": {
        "enabled": true,
        "scopes": ["docs", "api", "blog"]
      },
      "auth": {
        "enabled": false,
        "mode": "public"
      },
      "analytics": {
        "enabled": false,
        "provider": "watchfn",
        "respectDnt": true
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "diagnostics": []
  }
  ```
- Negative variant(s) when relevant:
  - Input omits `schemaVersion` and sets `site.basePath` to `"docs"`.
  - Expected error code + message:
    ```json
    {
      "ok": false,
      "diagnostics": [
        {
          "code": "DOCS_CONFIG_INVALID",
          "message": "site.basePath must start with '/' and schemaVersion must be 1"
        }
      ]
    }
    ```

## TV-DET-001

- Description: Two identical builds produce identical manifest and search hashes.
- Input:
  ```json
  {
    "buildA": {
      "root": "/repo/docsfn-fixtures/searchfn-docs",
      "configPath": "/repo/docsfn-fixtures/searchfn-docs/docsfn.config.ts"
    },
    "buildB": {
      "root": "/repo/docsfn-fixtures/searchfn-docs",
      "configPath": "/repo/docsfn-fixtures/searchfn-docs/docsfn.config.ts"
    }
  }
  ```
- Expected output:
  ```json
  {
    "manifestHashA": "sha256:4f...",
    "manifestHashB": "sha256:4f...",
    "searchHashA": "sha256:b1...",
    "searchHashB": "sha256:b1..."
  }
  ```
- Negative variant(s) when relevant:
  - Input changes only one page title in `buildB`.
  - Expected error code + message:
    ```json
    {
      "assertion": "manifestHashA !== manifestHashB",
      "message": "deterministic hash changed because normalized content changed"
    }
    ```

## TV-CMS-001

- Description: A contract-proof remote provider supplies stable IDs and timestamps without changing core API shape.
- Input:
  ```json
  {
    "providerId": "mock-remote",
    "listEntries": [
      {
        "id": "docs:getting-started",
        "collection": "docs",
        "relativePath": "getting-started.mdx",
        "etag": "W/123",
        "updatedAt": "2026-03-20T00:00:00Z"
      }
    ]
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "loadedIds": ["docs:getting-started"]
  }
  ```
- Negative variant(s) when relevant:
  - Input returns duplicate IDs for two different remote entries.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_PROVIDER_ERROR",
      "message": "provider emitted duplicate source entry id docs:getting-started"
    }
    ```

## TV-FS-001

- Description: Filesystem provider loads docs, blog, api, assets, and ignores `meta.json` as a page.
- Input:
  ```yaml
  root: /repo/site
  files:
    - content/docs/meta.json
    - content/docs/index.mdx
    - pages/changelog.mdx
    - blog/post-1.mdx
    - api/openapi.yaml
    - public/diagram.png
  ```
- Expected output:
  ```json
  {
    "collections": {
      "docs": ["content/docs/index.mdx"],
      "pages": ["pages/changelog.mdx"],
      "blog": ["blog/post-1.mdx"],
      "api": ["api/openapi.yaml"],
      "assets": ["public/diagram.png"]
    },
    "controlFiles": ["content/docs/meta.json"]
  }
  ```
- Negative variant(s) when relevant:
  - Input config points `docsDir` to a missing directory.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ENTRY_INVALID",
      "message": "configured docsDir content/docs does not exist"
    }
    ```

## TV-MIG-001

- Description: The Fumadocs compatibility preset builds the canonical `datafn/docs` fixture without source edits.
- Input:
  ```json
  {
    "root": "/repo/docsfn-fixtures/datafn-docs",
    "compatPreset": "fumadocs-v15",
    "site": {
      "title": "DataFn Docs",
      "basePath": "/docs"
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "blockingDiagnostics": 0,
    "routesInclude": ["/docs", "/docs/documentation/server/routes"],
    "compatTransforms": ["fumadocs-meta-json", "fumadocs-tabs", "mermaid-fence"]
  }
  ```
- Negative variant(s) when relevant:
  - Input includes `<Accordion>` imported from an unsupported Fumadocs package while the preset does not map it.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_COMPAT_UNSUPPORTED",
      "message": "unsupported compatibility construct Accordion from fumadocs-ui/components/accordion"
    }
    ```

## TV-ROUTE-001

- Description: Root and nested index pages resolve to parent routes.
- Input:
  ```yaml
  basePath: /docs
  files:
    - content/docs/index.mdx
    - content/docs/reference/index.mdx
    - content/docs/reference/client.mdx
  ```
- Expected output:
  ```json
  {
    "routes": {
      "/docs": "content/docs/index.mdx",
      "/docs/reference": "content/docs/reference/index.mdx",
      "/docs/reference/client": "content/docs/reference/client.mdx"
    },
    "nextParams": [{}, {"slug": ["reference"]}, {"slug": ["reference", "client"]}]
  }
  ```
- Negative variant(s) when relevant:
  - Input adds `content/docs/reference.mdx`, conflicting with `content/docs/reference/index.mdx`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ROUTE_CONFLICT",
      "message": "route /docs/reference is claimed by multiple source entries"
    }
    ```

## TV-ROUTE-002

- Description: Versioned route helpers agree across build and runtime lookup.
- Input:
  ```yaml
  basePath: /docs
  versions:
    mode: path-prefix
    versions:
      - slug: v1
        label: Version 1
        default: true
      - slug: v2
        label: Version 2
  files:
    - content/docs/v1/getting-started.mdx
    - content/docs/v2/getting-started.mdx
  ```
- Expected output:
  ```json
  {
    "routes": ["/docs/v1/getting-started", "/docs/v2/getting-started"],
    "staticParams": [
      {"version": "v1", "slug": ["getting-started"]},
      {"version": "v2", "slug": ["getting-started"]}
    ],
    "runtimeLookup": {
      "v1": "/docs/v1/getting-started",
      "v2": "/docs/v2/getting-started"
    }
  }
  ```
- Negative variant(s) when relevant:
  - Input produces `/docs/v2/v2/getting-started`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_VERSION_INVALID",
      "message": "version segment duplicated during route normalization"
    }
    ```

## TV-NAV-001

- Description: `meta.json` ordering controls the page tree.
- Input:
  ```yaml
  directory: content/docs
  meta.json:
    title: SearchFn
    pages:
      - index
      - getting-started
      - architecture
      - reference
      - integrations
      - operations
  files:
    - index.mdx
    - getting-started.mdx
    - architecture.mdx
    - reference/client.mdx
    - integrations/datafn.mdx
    - operations/setup.mdx
  ```
- Expected output:
  ```json
  {
    "sidebarOrder": [
      "SearchFn",
      "Getting Started",
      "Architecture",
      "Reference",
      "Integrations",
      "Operations"
    ]
  }
  ```
- Negative variant(s) when relevant:
  - Input `meta.json.pages` references `missing-page`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_META_INVALID",
      "message": "meta.json references unknown page id missing-page"
    }
    ```

## TV-NAV-002

- Description: Multiple sidebars, breadcrumbs, and pagination derive from canonical navigation data.
- Input:
  ```yaml
  navigation:
    sidebars:
      guides:
        include:
          - docs/documentation/**
      reference:
        include:
          - docs/reference/**
  currentRoute: /docs/reference/client
  ```
- Expected output:
  ```json
  {
    "activeSidebar": "reference",
    "breadcrumbs": [
      {"label": "DataFn", "href": "/docs"},
      {"label": "Reference", "href": "/docs/reference"},
      {"label": "Client", "href": "/docs/reference/client"}
    ],
    "pagination": {
      "prev": "/docs/reference/core",
      "next": "/docs/reference/server"
    }
  }
  ```
- Negative variant(s) when relevant:
  - Input route is not present in any sidebar.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ROUTE_NOT_FOUND",
      "message": "route /docs/reference/client is not present in the requested sidebar"
    }
    ```

## TV-MDX-001

- Description: Supported MDX compatibility constructs compile into working output.
- Input:
  ```mdx
  import { Tab, Tabs } from "fumadocs-ui/components/tabs";

  # Routes

  <Tabs items={["TypeScript", "Python"]}>
    <Tab value="TypeScript">TS body</Tab>
    <Tab value="Python">PY body</Tab>
  </Tabs>

  ```mermaid
  graph TD;
  ```
  ```
- Expected output:
  ```json
  {
    "compiled": true,
    "componentsUsed": ["DocsTabs", "DocsTab", "MermaidBlock"],
    "renderedHeadings": ["Routes"]
  }
  ```
- Negative variant(s) when relevant:
  - Input includes unsupported arbitrary JSX component `<Foo />` with no mapping.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_COMPAT_UNSUPPORTED",
      "message": "unsupported JSX component Foo in compatibility mode"
    }
    ```

## TV-MDX-002

- Description: TOC and anchors are AST-derived and stable for duplicates and Unicode.
- Input:
  ```md
  ## Overview

  ```bash
  # Not a heading
  ```

  ## Overview
  ## 日本語のヘディング
  ```
- Expected output:
  ```json
  {
    "headings": [
      {"text": "Overview", "slug": "overview"},
      {"text": "Overview", "slug": "overview-1"},
      {"text": "日本語のヘディング", "slug": "ri-ben-yu-nohedingu"}
    ]
  }
  ```
- Negative variant(s) when relevant:
  - Output contains duplicated `overview` for both headings or counts the code-fence line.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "heading anchor set is not deterministic or includes fenced-code false positives"
    }
    ```

## TV-PAGE-001

- Description: Resolved page includes page chrome metadata and extension slots.
- Input:
  ```json
  {
    "route": "/docs/documentation/server/routes",
    "site": {
      "canonicalUrl": "https://docs.example.com",
      "editLink": {
        "provider": "github",
        "owner": "21nCo",
        "repo": "super-functions",
        "branch": "next"
      },
      "pageActions": [
        {"id": "copy-markdown"},
        {"id": "ai-open"}
      ]
    }
  }
  ```
- Expected output:
  ```json
  {
    "title": "Routes",
    "canonical": "https://docs.example.com/docs/documentation/server/routes",
    "editLink": "https://github.com/21nCo/super-functions/blob/next/datafn/docs/content/docs/documentation/server/routes.mdx",
    "pageActions": ["copy-markdown", "ai-open"],
    "tocCount": 3,
    "hasBreadcrumbs": true,
    "hasPagination": true
  }
  ```
- Negative variant(s) when relevant:
  - Input route resolves but omits canonical metadata despite configured `canonicalUrl`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "resolved page is missing canonical metadata under configured canonicalUrl"
    }
    ```

## TV-SEARCH-001

- Description: Build search artifact indexes docs, api, and blog scopes.
- Input:
  ```json
  {
    "search": {
      "enabled": true,
      "scopes": ["docs", "api", "blog"],
      "bodyIndexing": "summary"
    },
    "manifestSummary": {
      "pages": 10,
      "apis": 2,
      "posts": 3
    }
  }
  ```
- Expected output:
  ```json
  {
    "engine": "searchfn",
    "documentCount": 15,
    "scopes": ["docs", "api", "blog"]
  }
  ```
- Negative variant(s) when relevant:
  - Search build throws internally and emits `{}`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_SEARCH_BUILD_FAILED",
      "message": "search artifact build failed; empty fallback snapshot is forbidden"
    }
    ```

## TV-SEARCH-002

- Description: Search runtime supports scopes, keyboard navigation, and stable results.
- Input:
  ```json
  {
    "query": "adapter",
    "scope": "api",
    "keyboardSequence": ["Meta+K", "ArrowDown", "Enter"]
  }
  ```
- Expected output:
  ```json
  {
    "dialogOpened": true,
    "resultsScope": "api",
    "selectedPath": "/docs/reference/adapters/indexeddb",
    "results": [
      {"title": "IndexedDB Adapter", "path": "/docs/reference/adapters/indexeddb"}
    ]
  }
  ```
- Negative variant(s) when relevant:
  - Query requests scope `foo`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_CONFIG_INVALID",
      "message": "unknown search scope foo"
    }
    ```

## TV-API-001

- Description: JSON and YAML OpenAPI inputs normalize into canonical operations and schemas.
- Input:
  ```yaml
  local:
    - api/core.json
    - api/admin.yaml
  ```
- Expected output:
  ```json
  {
    "apis": [
      {
        "id": "api/core.json",
        "tags": ["core"],
        "operations": ["GET /search", "POST /index"]
      },
      {
        "id": "api/admin.yaml",
        "tags": ["admin"],
        "operations": ["GET /health"]
      }
    ]
  }
  ```
- Negative variant(s) when relevant:
  - YAML file parses to an empty object because only JSON parsing was attempted.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_OPENAPI_PARSE_FAILED",
      "message": "OpenAPI YAML source api/admin.yaml could not be parsed"
    }
    ```

## TV-API-002

- Description: API routes and renderer derive from normalized operations.
- Input:
  ```json
  {
    "api": {
      "title": "Search API",
      "tags": ["indexing"],
      "operations": [
        {"method": "POST", "path": "/index", "summary": "Index a document"}
      ]
    }
  }
  ```
- Expected output:
  ```json
  {
    "routes": [
      "/docs/api",
      "/docs/api/tags/indexing",
      "/docs/api/operations/post-index"
    ],
    "renderer": {
      "shows": ["summary", "parameters", "requestBody", "responses", "schemas"]
    }
  }
  ```
- Negative variant(s) when relevant:
  - Requested route `/docs/api/operations/get-missing`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ROUTE_NOT_FOUND",
      "message": "API reference route /docs/api/operations/get-missing was not generated"
    }
    ```

## TV-BLOG-001

- Description: Blog posts generate tag pages, pagination, and RSS.
- Input:
  ```yaml
  posts:
    - slug: alpha
      title: Alpha
      date: 2026-03-01
      tags: [release]
    - slug: beta
      title: Beta
      date: 2026-03-02
      tags: [release, platform]
  ```
- Expected output:
  ```json
  {
    "listRoute": "/docs/blog",
    "tagRoutes": ["/docs/blog/tags/release", "/docs/blog/tags/platform"],
    "rssItems": ["beta", "alpha"]
  }
  ```
- Negative variant(s) when relevant:
  - A production build includes a draft post with `draft: true`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "draft post alpha was emitted in a production artifact"
    }
    ```

## TV-EMBED-001

- Description: Embedded page and surface modes reuse manifest data without requiring full-site shell.
- Input:
  ```json
  {
    "mode": "embedded-surface",
    "route": "/docs/reference/client"
  }
  ```
- Expected output:
  ```json
  {
    "embeddedPage": {
      "title": "Client API",
      "tocCount": 2
    },
    "embeddedSurface": {
      "hasSidebar": true,
      "hasSearchTrigger": true,
      "hasTopNavSlot": true
    }
  }
  ```
- Negative variant(s) when relevant:
  - Embedded surface forces `<html><body>` wrapper output.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "embedded mode emitted a full document shell"
    }
    ```

## TV-NEXT-001

- Description: Next.js site kit resolves root and nested routes correctly on Next 15 / React 19.
- Input:
  ```json
  {
    "framework": "next",
    "versions": null,
    "routes": ["/docs", "/docs/getting-started"]
  }
  ```
- Expected output:
  ```json
  {
    "generateStaticParams": [{}, {"slug": ["getting-started"]}],
    "resolvePage": {
      "/docs": "SearchFn",
      "/docs/getting-started": "Getting Started"
    },
    "metadata": {
      "/docs": {"canonical": "/docs"}
    }
  }
  ```
- Negative variant(s) when relevant:
  - `resolvePage` crashes when `slug` is absent for the root route.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ROUTE_NOT_FOUND",
      "message": "root docs page must resolve when params.slug is undefined"
    }
    ```

## TV-SVELTE-001

- Description: SvelteKit site kit resolves root and nested routes and ships valid typings.
- Input:
  ```json
  {
    "framework": "sveltekit",
    "routes": ["/docs", "/docs/reference/client"]
  }
  ```
- Expected output:
  ```json
  {
    "staticPaths": [{}, {"slug": "reference/client"}],
    "load": {
      "/docs": "SearchFn",
      "/docs/reference/client": "Client API"
    },
    "typesFileExists": true
  }
  ```
- Negative variant(s) when relevant:
  - The package declares `dist/index.d.ts` but the file is not emitted.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "@docsfn/svelte declares dist/index.d.ts but did not emit it"
    }
    ```

## TV-SEC-001

- Description: Unsafe HTML is rejected and protected routes enforce auth.
- Input:
  ```json
  {
    "content": "<script>alert(1)</script>",
    "auth": {
      "enabled": true,
      "mode": "private"
    },
    "request": {
      "route": "/docs/private",
      "session": null
    }
  }
  ```
- Expected output:
  ```json
  {
    "buildError": {
      "code": "DOCS_HTML_UNSAFE"
    },
    "requestError": {
      "code": "DOCS_AUTH_REQUIRED"
    }
  }
  ```
- Negative variant(s) when relevant:
  - Unsafe HTML renders successfully or private content resolves with no session.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "unsafe HTML or unauthorized content was rendered"
    }
    ```

## TV-OBS-001

- Description: watchfn analytics emit canonical events and honor DNT.
- Input:
  ```json
  {
    "analytics": {
      "enabled": true,
      "provider": "watchfn",
      "respectDnt": true
    },
    "browser": {
      "doNotTrack": "1"
    },
    "eventAttempt": {
      "name": "docs.pageview",
      "route": "/docs"
    }
  }
  ```
- Expected output:
  ```json
  {
    "eventsEmitted": 0
  }
  ```
- Negative variant(s) when relevant:
  - DNT is set and an event still emits.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "analytics emitted while DNT was enabled"
    }
    ```

## TV-CLI-001

- Description: CLI validate/build fail closed and emit canonical artifacts.
- Input:
  ```json
  {
    "commandSequence": [
      "docsfn validate /repo/docsfn-fixtures/searchfn-docs --config docsfn.config.ts",
      "docsfn build /repo/docsfn-fixtures/searchfn-docs --config docsfn.config.ts --out .docsfn"
    ]
  }
  ```
- Expected output:
  ```json
  {
    "validateExitCode": 0,
    "buildExitCode": 0,
    "artifacts": [
      ".docsfn/manifest.json",
      ".docsfn/search.json",
      ".docsfn/diagnostics.json",
      ".docsfn/compat-report.json"
    ]
  }
  ```
- Negative variant(s) when relevant:
  - Build encounters invalid config and silently uses default values.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_CONFIG_INVALID",
      "message": "invalid config was not allowed to fall back silently"
    }
    ```

## TV-PKG-001

- Description: All packages build and emit metadata-consistent outputs.
- Input:
  ```json
  {
    "packages": [
      "docsfn/core",
      "docsfn/provider-fs",
      "docsfn/react",
      "docsfn/svelte",
      "docsfn/next",
      "docsfn/sveltekit",
      "docsfn/cli"
    ]
  }
  ```
- Expected output:
  ```json
  {
    "allBuildsPass": true,
    "declaredTypesExist": true,
    "corePackageName": "@docsfn/core",
    "reactPeerRangesInclude": ["^18.0.0", "^19.0.0"]
  }
  ```
- Negative variant(s) when relevant:
  - `@docsfn/react` fails build or core package name is `docsfn`.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "package metadata and emitted outputs are inconsistent"
    }
    ```

## TV-TEST-001

- Description: Release-gate test matrix exercises real fixtures and both example site kits.
- Input:
  ```json
  {
    "fixtures": ["datafn-docs", "searchfn-docs"],
    "examples": ["next-docs-site", "sveltekit-docs-site"]
  }
  ```
- Expected output:
  ```json
  {
    "coreTests": "pass",
    "providerTests": "pass",
    "integrationTests": "pass",
    "exampleE2E": "pass"
  }
  ```
- Negative variant(s) when relevant:
  - `datafn-docs` fixture fails while the release command still returns success.
  - Expected error code + message:
    ```json
    {
      "code": "DOCS_ARTIFACT_INVALID",
      "message": "release gate passed despite failing migration fixture coverage"
    }
    ```
