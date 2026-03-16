# Metadata
- Timestamp: 2026-03-15T12:43:27Z
- agent_name: unknown-agent
- model: gpt-5-codex
- launcher: Codex Desktop
- Workspace: `/Users/serro/Documents/dev/n/superfunctions/datafn`
- Repo root: `/Users/serro/Documents/dev/n/superfunctions`
- OS + shell: `Darwin 25.3.0`, `zsh`
- Git:
  - branch: `heads/next`
  - commit: `5fe59b66a1ebf692ef723eb68f708e60a90de457`
  - dirty: `true`
- spec_folder: `2026-03-15-new-ug0uwash-spec`
- spec_folder_path: `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-15-new-ug0uwash-spec`
- spec_type: `new`
- spec_id: `ug0uwash`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/datafn.intent.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-recommendations-beginner-guide.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/client/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/**/*.mdx` (scanned via inventory and focused reads)
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/**/meta.json` (scanned via inventory and focused reads)
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/layout.config.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/docs/layout.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/docs/[[...slug]]/page.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/lib/source.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/source.config.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/package.json`
- Audit-fix linkage: `N/A`

## Overview
Project name: DataFn public docs

One-sentence goal:
Restructure and rewrite the public DataFn docs site so a first-time outsider can understand what DataFn is, how to start, and how major features fit together, while preserving full technical coverage in clean guide/reference boundaries and removing all public legacy and migration material.

Target users:
- First-time evaluators who do not know DataFn vocabulary yet.
- Product engineers implementing a real DataFn app.
- Maintainers verifying that public docs remain accurate to the current codebase.
- Readers comparing TypeScript and Python runtime support.

Target environments:
- Public docs site under `datafn/docs`, built with Next.js + Fumadocs.
- Browser readers on desktop and mobile.
- Local authoring/verification on macOS/Linux with Node/npm.

Languages/packages required:
- MDX content and `meta.json` navigation files.
- TypeScript for any docs-audit or snippet-validation scripts.
- Existing docs app stack: Next.js, Fumadocs, local source loader.

Existing systems it must integrate with:
- `datafn/docs/content/docs/**/*` content tree and `meta.json` sidebar structure.
- `datafn/docs/app/docs/layout.tsx` and `datafn/docs/lib/source.ts`.
- Real example apps under `datafn/examples/*`.
- Current DataFn package surfaces documented by `@datafn/core`, `@datafn/client`, `@datafn/server`, and the Python package.

Data model summary:
- Public docs pages (`*.mdx`) grouped by `meta.json`.
- Top-level public sections: root landing, guides, DFQL, CLI, reference.
- Multiple guide clusters: concepts, client, server, sync, storage, plugins, database, advanced.
- Sharing content currently split across concepts, sync, and use-cases.

Security model:
- Public docs MUST be truthful about what the current codebase supports.
- Public docs MUST NOT publish migration playbooks, compatibility windows, or deprecated call shapes.
- Public docs MUST clearly state runtime applicability when TypeScript and Python differ.
- Public docs MUST NOT imply unsafe behaviors such as client-controlled server namespace selection.

Performance constraints:
- The docs build MUST remain local-only and deterministic.
- Any docs audit/check command MUST run without external services.
- The rewrite MUST fit the current Fumadocs content pipeline; no docs platform migration is in scope.

Non-goals:
- Rebuilding the entire docs UI theme or replacing Fumadocs.
- Shipping versioned docs, localization, or docs analytics.
- Rewriting package README files unless directly required by docs-site snippet provenance.
- Adding new product features to make the docs “easier” to write.

Hard constraints:
- Public docs MUST remove all legacy, deprecation, and migration guidance because DataFn is not yet published and has no user migration burden.
- The docs MUST stay comprehensive: client, server, sync, sharing, storage, plugins, database, DFQL, CLI, and reference all remain in scope.
- The docs MUST distinguish newcomer guides from exhaustive reference material.
- The docs MUST preserve accuracy to actual runtime/package support rather than aspirational product language.

## Glossary
- Public docs: The site content rooted at `datafn/docs/content/docs`.
- Guide page: A task-first page that helps a reader do something concrete.
- Concept page: A mental-model page that explains what a feature is, why it exists, and when to use it.
- Reference page: An exhaustive API/contract page optimized for lookup after the reader already knows the basics.
- Landing page: A section entry page that explains what lives in that section and where to start.
- Outsider reader: A technically capable reader who does not know DataFn-specific jargon or internal architecture yet.
- Canonical example: A code or workflow example sourced from the real repo and treated as the authoritative public teaching example.
- Applicability note: A page-level statement that says whether the page applies to TypeScript, Python, or both.
- Under the hood: A clearly labeled late-page section for internal tables, execution details, or implementation internals.
- Public legacy content: Any public mention of deprecated APIs, migration workflows, backward-compatibility windows, or now-obsolete recommended paths.

## Goals / Non-goals
### Goals
1. The docs MUST let a newcomer answer three questions quickly: “What is DataFn?”, “Where do I start?”, and “Which page should I read next?”
2. The docs MUST present typed client/server APIs and example apps as the primary authoring path, with DFQL positioned as the underlying language and reference surface.
3. The docs MUST keep full technical depth without forcing beginners to read internal table schemas or execution internals before learning the mental model.
4. The docs MUST consolidate sharing guidance into one coherent public learning path.
5. The docs MUST remove all public migration/deprecation/compatibility material.
6. The docs MUST expose truthful runtime support boundaries, especially for TypeScript vs Python.
7. The docs MUST be enforceable by local docs checks, not only by manual taste.

### Non-goals
1. This spec does not require a new design system or custom docs renderer.
2. This spec does not require generated API docs from TypeScript source.
3. This spec does not require package README rewrites unless a docs page depends on them for snippet provenance.
4. This spec does not require preserving current public URLs because DataFn is unpublished.

## Public API
### Target public section tree
The public docs MUST expose this top-level tree:

```text
content/docs/
  index.mdx
  meta.json
  documentation/
    index.mdx
    meta.json                 # title: "Guides"
    concepts/
      meta.json
      overview.mdx
      glossary.mdx            # new
      capabilities.mdx
      multi-tenancy.mdx
    client/
      meta.json
      setup.mdx
      queries.mdx
      mutations.mdx
      transactions.mdx
      signals.mdx
      frameworks.mdx
      events.mdx
      kv.mdx
      tables.mdx
    server/
      meta.json
      setup.mdx
      routes.mdx
      authorization.mdx
      validation.mdx
      rest-api.mdx
      websockets.mdx
      rate-limiting.mdx
      observability.mdx
    sync/
      meta.json
      overview.mdx
      offline-first.mdx
      clone.mdx
      pull-push.mdx
      hydration.mdx
      clone-up.mdx
      cross-tab.mdx
    sharing/
      meta.json               # new
      overview.mdx            # moved/replaced
      patterns.mdx            # moved/replaced
      sync-lifecycle.mdx      # moved/replaced
    storage/
      meta.json
      overview.mdx
      indexeddb.mdx
      memory.mdx
      custom.mdx
    plugins/
      meta.json
      overview.mdx
      client-search.mdx
      custom-plugins.mdx
    database/
      meta.json
      adapters.mdx
      drizzle.mdx
      transactions.mdx
    advanced/
      meta.json
      idempotency.mdx
      change-tracking.mdx
      guards.mdx
      debouncing.mdx
      error-handling.mdx
      security.mdx
  dfql/
  cli/
  reference/
```

### Required public moves/removals
The public docs rewrite MUST apply this move/removal map:

| Current path | Action | Target public path |
| --- | --- | --- |
| `datafn/docs/content/docs/documentation/concepts/sharing-v2.mdx` | Move + rewrite | `datafn/docs/content/docs/documentation/sharing/overview.mdx` |
| `datafn/docs/content/docs/documentation/sync/sharing-sync-lifecycle.mdx` | Move + rewrite | `datafn/docs/content/docs/documentation/sharing/sync-lifecycle.mdx` |
| `datafn/docs/content/docs/documentation/use-cases/sharing-patterns.mdx` | Move + rewrite | `datafn/docs/content/docs/documentation/sharing/patterns.mdx` |
| `datafn/docs/content/docs/documentation/migrations/meta.json` | Remove from public tree | `N/A` |
| `datafn/docs/content/docs/documentation/migrations/spv2.mdx` | Remove from public docs | `N/A` |

If maintainers still need migration notes, those notes MUST live outside `datafn/docs/content/docs`, for example under `datafn/.conduct/**`.

### Canonical page frontmatter envelope
Every public MDX page MUST declare this frontmatter envelope:

```yaml
---
title: "Human-friendly page title"
description: "One outsider-friendly sentence saying what the page helps with."
audience: "landing" | "guide" | "concept" | "reference"
applies_to: "typescript" | "python" | "both"
---
```

Rules:
- `title` MUST be plain-language and MUST NOT lead with internal version names like `V2` unless the plain-language term comes first.
- `description` MUST describe reader benefit, not internal implementation mechanics.
- `audience` MUST match the page template rules below.
- `applies_to` MUST reflect the real support surface as implemented today.

### Canonical docs audit command
The docs package MUST expose a local audit command:

```bash
npm --prefix datafn/docs run docs:audit
```

Success result envelope:

```json
{
  "ok": true,
  "summary": {
    "pagesScanned": 72,
    "navFilesScanned": 15,
    "errorCount": 0,
    "warningCount": 0
  },
  "findings": []
}
```

Failure result envelope:

```json
{
  "ok": false,
  "summary": {
    "pagesScanned": 72,
    "navFilesScanned": 15,
    "errorCount": 2,
    "warningCount": 1
  },
  "findings": [
    {
      "code": "DOCS_LEGACY_PUBLIC",
      "severity": "error",
      "path": "datafn/docs/content/docs/documentation/sharing/overview.mdx",
      "line": 18,
      "message": "Public docs mention a deprecated share API shape."
    }
  ]
}
```

## Data formats / protocol
### `meta.json` section contract
Every public section `meta.json` MUST use this canonical shape:

```json
{
  "title": "Section Title",
  "root": true,
  "pages": ["index", "child-folder-or-page"]
}
```

Rules:
- `title` MUST use reader-facing language.
- `pages` order MUST reflect the learning order defined by this spec.
- A page MUST NOT appear in the sidebar if its replacement target has already been promoted into public navigation.
- Removed sections (`migrations`, old `use-cases`) MUST NOT remain referenced from any public `meta.json`.

### Page-template contracts
#### Landing pages
Landing pages (`audience: landing`) MUST include:
- A plain-language section summary.
- “Who this is for”.
- “Start here” or equivalent next-step list.
- Links to the most relevant child pages.

#### Guide pages
Guide pages (`audience: guide`) MUST include:
- `## Overview`
- `## Before You Start`
- A shortest-working-example section
- A verification section or explicit expected outcome
- `## Next Steps`

Guide pages MUST link to the matching reference page when exhaustive options exist.

#### Concept pages
Concept pages (`audience: concept`) MUST include:
- `## In Plain Language`
- `## Why It Exists`
- A small narrative example
- Rules of thumb or common mistakes
- Optional `## Under The Hood` as the last major section only

#### Reference pages
Reference pages (`audience: reference`) MUST include:
- A one-paragraph plain-language summary
- At least one minimal example
- Parameter/member/type details
- Error or edge-case notes
- Links back to related guide pages

## Semantics
### Navigation semantics
1. `/docs` MUST become the real newcomer homepage rather than a sparse architecture splash.
2. The top-level sidebar MUST keep the published learning order:
   1. Root landing
   2. Guides
   3. DFQL
   4. Reference
   5. CLI
3. The Guides section MUST keep this order:
   1. Getting Started
   2. Concepts
   3. Client
   4. Server
   5. Sync
   6. Sharing
   7. Storage
   8. Plugins
   9. Database
   10. Advanced
4. The Concepts subsection MUST keep this order:
   1. Overview
   2. Glossary
   3. Capabilities
   4. Namespaces
5. The Sharing subsection MUST keep this order:
   1. Sharing Overview
   2. Sharing Patterns
   3. Sharing Sync Lifecycle

### Content semantics
1. Beginner-facing pages MUST explain DataFn’s typed client/server path before sending readers into raw DFQL.
2. DFQL pages MUST present DFQL as the portable query/mutation language and wire/reference surface, not the recommended first page for brand-new users.
3. Public docs MUST use plain language before internal nouns. Example: “share target (principal)” is allowed; leading with “principal hierarchy” without plain framing is not.
4. Guides MUST explain the common path first and link to reference for exhaustive options.
5. Internal details such as `__datafn_*` tables, pipeline internals, and class names MAY appear only in `Under the hood` sections or reference pages.
6. The docs MUST cross-link dependent concepts explicitly. Examples:
   - Sharing pages link to capabilities, namespaces, and sync.
   - Setup pages link to reference config pages.
   - Reference pages link back to at least one guide.

### Section-specific semantics
#### Root + Getting Started
- The root landing page MUST answer what DataFn is, why someone would choose it, and where to start.
- `documentation/index.mdx` MUST provide one coherent quickstart that defines a schema, creates a server, creates a client, runs one query/mutation, and points to the example apps.

#### Client + Server
- `documentation/client/setup.mdx` and `documentation/server/setup.mdx` MUST prioritize a shortest-working path.
- Exhaustive configuration tables MUST move to or defer to `reference/client/config.mdx` and `reference/server/config.mdx`.
- Pages with TypeScript/Python differences MUST say so near the top.

#### Sync
- Sync pages MUST explain clone, pull, push, hydration, and cross-tab in user-task language first.
- Sharing-specific sync behavior MUST no longer live inside the generic sync subtree.

#### Sharing
- Public sharing docs MUST use “Sharing” as the page/section term.
- “SPV2” MAY appear once inside the body as an internal implementation label, but it MUST NOT be the public section title.
- Sharing docs MUST teach namespace, actor, principal, access level, and grant scope through narrative examples before internal tables or indexes.
- Sharing docs MUST omit migration, compatibility-window, and legacy payload guidance entirely.

#### Search
- Search docs MUST describe the current recommended provider-backed model only.
- Public docs MUST NOT recommend or document legacy MiniSearch mode.
- Search-related guide/reference pages MUST present one coherent story across DFQL search, client search setup, and the search-provider contract.

#### Advanced, Plugins, Database, Storage
- These guide clusters MUST open with “when you need this” rather than raw interfaces or internal classes.
- Internal contracts MAY remain in reference pages, but not as the lead teaching surface in guides.

#### Reference and CLI
- Reference pages MUST remain exhaustive but approachable.
- CLI pages MUST be task-first, accurate to actual commands, and linked from the guides where relevant.

## Invariants
1. Every public page MUST have the canonical frontmatter envelope.
2. Every guide/concept/reference page MUST satisfy its template contract.
3. Public docs MUST NOT contain:
   - `documentation/migrations/**`
   - `shareWith.userId`
   - deprecated positional sharing APIs
   - “legacy MiniSearch” guidance
   - compatibility-window or rollback instructions
4. Every moved page MUST have all internal links updated to its new public path.
5. Every newcomer-facing page MUST include at least one next-step link.
6. Every reference page MUST include at least one related-guide link.
7. Every page with TypeScript/Python differences MUST expose an applicability note near the top.
8. Every public code example MUST be traceable to a real example app, test, or maintained snippet source.
9. Docs audit output ordering MUST be deterministic: findings sorted by `path`, then `line`, then `code`.

## Security
1. Public docs MUST NOT teach unsupported or deprecated APIs as current recommendations.
2. Public docs MUST NOT obscure real runtime limitations. If a route or feature is TypeScript-only, that fact MUST be visible near the top of the relevant page.
3. Public docs MUST NOT publish internal-only migration or rollback instructions under the public docs site.
4. Public docs MUST preserve correct security explanations, including server-derived namespace/actor behavior and authorization boundaries.

## Limits/caps
1. A guide page MUST NOT lead with an exhaustive configuration table or raw interface dump when a dedicated reference page exists.
2. A concept page MUST NOT introduce internal tables or indexes before the plain-language explanation and first example.
3. A public guide page MUST keep “Under the hood” as the last major section when used.
4. A public docs rewrite phase MUST prefer moving surplus detail into reference rather than duplicating it in both guide and reference pages.

## Observability
The docs package MUST provide local observability through:
- `npm --prefix datafn/docs run docs:audit`
- `npm --prefix datafn/docs run build`
- Optional manual route verification during rewrite phases

The audit MUST support these stable error codes:
- `DOCS_FRONTMATTER_MISSING`
- `DOCS_FRONTMATTER_INVALID`
- `DOCS_NAV_INVALID`
- `DOCS_SECTION_MISSING`
- `DOCS_LEGACY_PUBLIC`
- `DOCS_RUNTIME_SCOPE_MISSING`
- `DOCS_RELATED_LINK_MISSING`
- `DOCS_SNIPPET_SOURCE_MISSING`
- `DOCS_BROKEN_LINK`

Failure behavior:
- Any `error` severity finding MUST fail the docs audit command.
- Warnings MAY be emitted, but they MUST NOT be used to hide public legacy/migration content.

## Compatibility / versioning strategy
1. DataFn public docs are single-current-version docs for an unpublished library.
2. Breaking URL or sidebar changes are allowed if they improve clarity and all internal links are updated in the same change.
3. Deprecated or migration-oriented content MUST be removed from public docs instead of being preserved for backward compatibility.
4. If maintainers need archival notes, those notes MUST live under `datafn/.conduct/**` rather than under `datafn/docs/content/docs/**`.

## Undefined / Explicitly user-deferred only
None.
