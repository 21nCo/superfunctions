# Metadata

- **timestamp**: 2026-03-14T18:50:49Z
- **agent_name**: unknown-agent
- **model**: gpt-5-codex
- **launcher**: Codex Desktop
- **workspace**: /Users/serro/Documents/dev/n/superfunctions
- **os**: Darwin 25.3.0 arm64
- **shell**: /bin/zsh
- **git.branch**: heads/next
- **git.commit**: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- **git.dirty**: true
- **spec_type**: fix
- **spec_id**: ifnaigab
- **spec_folder**: 2026-03-15-fix-ifnaigab-spec
- **spec_path**: /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-15-fix-ifnaigab-spec
- **input_paths**:
  - In-thread user request dated 2026-03-15 describing weak root docs copy, poor sidebar grouping, removal of migrations/deprecations, and the need for comprehensive external-facing shared-package docs
  - /Users/serro/Documents/dev/n/superfunctions/AGENTS.md
  - /Users/serro/.codex/skills/spec/SKILL.md
  - /Users/serro/Documents/dev/n/superfunctions/docs/package.json
  - /Users/serro/Documents/dev/n/superfunctions/docs/app/layout.config.tsx
  - /Users/serro/Documents/dev/n/superfunctions/docs/app/docs/layout.tsx
  - /Users/serro/Documents/dev/n/superfunctions/docs/app/docs/[[...slug]]/page.tsx
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/index.mdx
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/getting-started.mdx
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/meta.json
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/shared/meta.json
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/shared/index.mdx
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/shared/auth.mdx
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/shared/http.mdx
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/shared-packages/meta.json
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/migrations/meta.json
  - /Users/serro/Documents/dev/n/superfunctions/docs/content/docs/operations/meta.json
  - /Users/serro/Documents/dev/n/superfunctions/docs/scripts/check-shared-package-coverage.mjs
  - /Users/serro/Documents/dev/n/superfunctions/docs/scripts/check-snippets.mjs
  - /Users/serro/Documents/dev/n/superfunctions/docs/scripts/check-links.mjs
  - /Users/serro/Documents/dev/n/superfunctions/packages/auth/README.md
  - /Users/serro/Documents/dev/n/superfunctions/packages/http/README.md
  - /Users/serro/Documents/dev/n/superfunctions/packages/db/README.md
  - /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/PLAN.md
  - /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/phase-reports/PHASE_17-2026-03-13-k6m9p2q-report.md
  - /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/phase-reports/PHASE_18-2026-03-13-r8k4m2p-report.md
- **related_prior_bundle**:
  - path: /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec
  - note: This prior bundle created the current root docs scaffold and placeholder shared-package pages. This spec replaces its docs information architecture and content strategy.

# Overview

## Project context

- **Project name**: Superfunctions root docs
- **One-sentence goal**: Rebuild the root `docs/` site into a beginner-first, category-organized, external-facing documentation experience that explains the Superfunctions mission and ecosystem and thoroughly documents every shared package.
- **Target users**:
  - External library authors evaluating `@superfunctions/*` and Python shared packages
  - Application engineers deciding which Superfunctions packages to compose
  - Contributors who need a public-facing explanation of package scope without internal monorepo context
- **Target environments**:
  - Static docs rendered in the existing Next.js + Fumadocs root docs app
  - Desktop and mobile web browsers
  - Local docs development via `npm -w docs run dev`
- **Languages/packages required**:
  - MDX under `docs/content/docs`
  - TypeScript/JavaScript for docs layout and verification scripts
  - Existing shared packages under `packages/*` and `packages/python-*`
- **Existing systems it must integrate with**:
  - Current root docs app in `docs/`
  - `@superfunctions/docs-theme`
  - Fumadocs page tree generation from `meta.json`
  - Existing package README files and package metadata as canonical technical source material
- **Data model summary**:
  - A docs page tree
  - A machine-readable shared-package catalog
  - A machine-readable ecosystem catalog
  - Deterministic docs quality-check results emitted as JSON from local scripts
- **Security model**:
  - Public docs only; no auth required
  - No secrets, internal-only runbooks, private URLs, or unpublished migration/deprecation guidance in user-facing root docs
- **Performance constraints**:
  - `npm -w docs run build` MUST remain successful locally
  - Docs verification scripts MUST complete in local development without external services
  - Content-quality checks SHOULD be deterministic and fast enough for pre-commit or local repeated runs
- **Non-goals / out of scope**:
  - Rewriting dedicated docs apps for `datafn`, `searchfn`, `hostfn`, or other top-level functions
  - Changing package APIs or renaming packages
  - Publishing/versioning the docs site
  - Adding internationalization, docs search tuning, or analytics
- **Hard constraints**:
  - Keep the existing root docs workspace and Fumadocs stack
  - Treat the site as an external/public docs surface, not an internal implementation notebook
  - No migration, legacy, deprecation, or release-note sections in root docs navigation or package pages
  - Use real package names and real imports only

The current root docs pass structural checks while still reading like placeholders. The site title, landing page, sidebar labels, package grouping, and most package pages are written as if they are internal scaffolding. This spec fixes the information architecture, content contract, and local quality gates so that the docs become useful to first-time external readers.

# Glossary

- **Root docs site**: The `docs/` workspace at the repo root that documents the Superfunctions ecosystem and the reusable shared packages.
- **Shared package**: A reusable package under `packages/*` or `packages/python-*` intended for composition across multiple Superfunctions and by external consumers.
- **Primitive package**: A low-level shared package such as `@superfunctions/http`, `@superfunctions/db`, or `@superfunctions/envelope`.
- **Category overview page**: A landing page for one user-facing package group such as Authentication & OAuth or Data & Storage.
- **Package page**: A single docs page for one shared package or Python integration package.
- **Start Here section**: The root onboarding group containing the introduction, getting-started, package chooser, and ecosystem pages.
- **Ecosystem catalog**: A machine-readable list of top-level Superfunctions and where readers should go next for their docs.
- **Package catalog**: A machine-readable list of shared-package docs entries, categories, ordering, and content requirements.
- **External library author**: A developer building their own package, SDK, or service on top of Superfunctions shared packages.
- **Placeholder copy**: Generic prose that does not explain real behavior, tradeoffs, or usage. Examples include “Reference and usage guidance” and fake production examples with no executable substance.

# Goals / Non-goals

## Goals

1. The root docs MUST explain what Superfunctions is, who the root docs are for, and how the ecosystem fits together.
2. The sidebar MUST be reorganized by beginner-friendly package categories instead of “Shared” buckets.
3. Every shared package page MUST be rewritten with thorough, real, external-world-oriented content.
4. The root docs MUST link readers to the broader Superfunctions ecosystem, including top-level function docs entry points.
5. The docs MUST stop surfacing migrations, legacy notes, deprecations, and release-note content in this root site.
6. Local verification MUST block the current class of “technically present but content-thin” placeholder pages.

## Non-goals

1. This spec does not require a new docs framework or a new root app.
2. This spec does not create or rewrite dedicated docs products for each function package.
3. This spec does not add versioned docs, migration guides, deprecation policy docs, or release-note feeds.

# Public API

The implementation MUST add machine-readable catalogs and docs QA contracts so structure and completeness are testable.

```ts
export type DocsCategoryId =
  | "start-here"
  | "authentication"
  | "http"
  | "middleware-runtime"
  | "data-storage"
  | "python"
  | "tooling";

export interface PackageDocEntry {
  slug: string;
  packageName: string;
  title: string;
  category: Exclude<DocsCategoryId, "start-here">;
  language: "typescript" | "python";
  order: number;
  summary: string;
  sourcePaths: readonly string[];
  requiredSections: readonly string[];
  relatedPackages: readonly string[];
}

export interface EcosystemEntry {
  slug: string;
  title: string;
  summary: string;
  href: string;
  hrefKind: "root-docs" | "workspace-docs" | "repo-path" | "external";
}

export type DocsCheckErrorCode =
  | "DOCS_BRANDING_INVALID"
  | "DOCS_NAV_INVALID"
  | "DOCS_ECOSYSTEM_INCOMPLETE"
  | "DOCS_CATEGORY_OVERVIEW_INCOMPLETE"
  | "DOCS_PACKAGE_PAGE_INCOMPLETE"
  | "DOCS_EXAMPLE_INVALID"
  | "DOCS_SCOPE_VIOLATION"
  | "DOCS_CATALOG_INVALID"
  | "DOCS_CONTENT_INVALID"
  | "DOCS_LINK_INVALID"
  | "DOCS_SNIPPET_INVALID";

export interface DocsCheckResult {
  ok: boolean;
  error?: { code: DocsCheckErrorCode };
}

export interface DocsContentCheckResult extends DocsCheckResult {
  missingPages: string[];
  missingSections: Array<{ path: string; headings: string[] }>;
  wrongCategory: Array<{ slug: string; expected: string; actual: string }>;
  thinPages: Array<{ path: string; proseWords: number; minWords: number }>;
  placeholderHits: Array<{ path: string; phrase: string }>;
  invalidExamples: Array<{ path: string; reason: string }>;
}
```

# Data formats / protocol

## Canonical information architecture

The user-facing sidebar MUST use the following top-level order:

1. `Start Here`
2. `Authentication & OAuth`
3. `HTTP & Framework Adapters`
4. `Middleware & Runtime`
5. `Data & Storage`
6. `Python Integrations`
7. `Tooling`

The docs content tree MUST be reorganized to routes equivalent to:

```text
/docs
/docs/getting-started
/docs/choosing-packages
/docs/ecosystem
/docs/authentication
/docs/authentication/auth
/docs/authentication/oauth-core
/docs/authentication/oauth-http
/docs/authentication/oauth-providers
/docs/authentication/oauth-storage
/docs/authentication/oauth-flow
/docs/authentication/oauth-testing
/docs/http
/docs/http/http
/docs/http/http-express
/docs/http/http-fastify
/docs/http/http-hono
/docs/http/http-next
/docs/http/http-sveltekit
/docs/middleware-runtime
/docs/middleware-runtime/middleware
/docs/middleware-runtime/webhooks
/docs/middleware-runtime/queue
/docs/middleware-runtime/envelope
/docs/middleware-runtime/errors
/docs/middleware-runtime/metrics
/docs/middleware-runtime/config
/docs/data-storage
/docs/data-storage/db
/docs/data-storage/storage
/docs/data-storage/storage-s3
/docs/data-storage/storage-r2
/docs/data-storage/storage-minio
/docs/data-storage/storage-gcs
/docs/data-storage/storage-azure
/docs/data-storage/storage-local
/docs/data-storage/files
/docs/python
/docs/python/python-core
/docs/python/python-fastapi
/docs/python/python-flask
/docs/python/python-sqlalchemy
/docs/tooling
/docs/tooling/cli
/docs/tooling/docs-theme
```

User-facing labels MUST match:

- `Start Here`
- `Authentication & OAuth`
- `HTTP & Framework Adapters`
- `Middleware & Runtime`
- `Data & Storage`
- `Python Integrations`
- `Tooling`

The following top-level navigation buckets MUST NOT exist after implementation:

- `Shared Docs`
- `Superfunctions Shared`
- `Shared Packages`
- `migration`
- `migrations`
- `operations`
- `release-notes-and-deprecations`

## Required page contracts

### Start Here pages

- `/docs` MUST include:
  - `## What Superfunctions Is`
  - `## Who These Docs Are For`
  - `## How the Ecosystem Fits Together`
  - `## Start With These Packages`
- `/docs/getting-started` MUST include:
  - `## Choose Your Starting Point`
  - `## Install Your First Package`
  - `## Build a Small Example`
  - `## Where To Go Next`
- `/docs/choosing-packages` MUST include:
  - `## If You Need Authentication`
  - `## If You Need HTTP Routing`
  - `## If You Need Storage or Persistence`
  - `## If You Are Building a Library`
- `/docs/ecosystem` MUST include:
  - `## Core Superfunctions`
  - `## What The Root Docs Cover`
  - `## Where To Find Function-Specific Docs`

### Category overview pages

Each category overview page MUST include:

- `## What This Category Covers`
- `## Package Map`
- `## How To Choose`
- `## Common Compositions`
- `## Related Categories`

### Package pages

Each package page MUST include:

- `## What It Is`
- `## When To Use It`
- `## Install`
- `## Quick Start`
- `## Core Concepts`
- `## Real-World Example`
- `## Related Packages`
- `## Troubleshooting`

## Docs check JSON contracts

Scripts MUST emit machine-readable JSON with deterministic keys.

Success payload example:

```json
{
  "ok": true,
  "missingPages": [],
  "missingSections": [],
  "wrongCategory": [],
  "thinPages": [],
  "placeholderHits": [],
  "invalidExamples": []
}
```

Failure payload example:

```json
{
  "ok": false,
  "error": { "code": "DOCS_CONTENT_INVALID" },
  "missingPages": ["docs/content/docs/ecosystem.mdx"],
  "missingSections": [
    {
      "path": "docs/content/docs/http/http.mdx",
      "headings": ["## Real-World Example", "## Related Packages"]
    }
  ],
  "wrongCategory": [],
  "thinPages": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "proseWords": 94,
      "minWords": 350
    }
  ],
  "placeholderHits": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "phrase": "Reference and usage guidance"
    }
  ],
  "invalidExamples": [
    {
      "path": "docs/content/docs/data-storage/db.mdx",
      "reason": "monorepo-only import"
    }
  ]
}
```

# Semantics

## Site identity

- The site title MUST be `Superfunctions`.
- The root docs page MUST describe the mission and package ecosystem in plain language.
- The root docs MUST clearly tell readers that the site documents shared packages and points to separate function docs for product-specific features.

## Sidebar and grouping semantics

- Grouping MUST follow reader tasks and package scope, not repo-internal folder names.
- Each shared package MUST belong to exactly one category.
- Package ordering within a category MUST be deterministic and reader-friendly:
  - foundation package first
  - closely related orchestration packages next
  - adapters/providers last
  - alphabetical order MAY be used only within a sub-cluster of equals

## Package page semantics

- Package pages MUST explain the problem the package solves before showing API details.
- Examples MUST be framed for external readers first.
- Package pages SHOULD mention how the package composes with sibling packages.
- Package pages MAY mention relevant Superfunctions consumers, but that content MUST be secondary to external usage.

## Category-specific semantics

- Authentication & OAuth pages MUST explain the stack layering:
  - `auth` as generic auth abstraction
  - `oauth-core`/`oauth-http`/`oauth-storage`/`oauth-providers` as lower-level pieces
  - `oauth-flow` as the high-level orchestration package
  - `oauth-testing` as test support
- HTTP pages MUST explain the separation between `@superfunctions/http` and framework adapters.
- Data & Storage pages MUST explain the difference between `db`, `storage`, storage provider adapters, and `files`.
- Python pages MUST explain which shared concepts map from TypeScript to Python integrations.

## Ecosystem semantics

The ecosystem page MUST include a stable catalog of top-level Superfunctions, including at minimum:

- `authfn`
- `cachefn`
- `drawfn`
- `plugfn`
- `searchfn`
- `secfn`
- `testfn`
- `botfn`
- `hostfn`
- `uifn`
- `watchfn`
- `billfn`
- `browsefn`
- `chartfn`
- `datafn`
- `docsfn`
- `filefn`
- `flowfn`
- `iconfn`
- `logfn`
- `sendfn`

Each entry MUST include a one-line explanation and a link target to either:

- a dedicated docs app,
- a repo docs directory,
- a README or SPEC entry point,
- or another explicit public landing page.

## Removal semantics

- The root docs MUST remove user-facing migration, legacy, deprecation, and release-note content.
- Breaking route changes inside the root docs are allowed because the packages are not yet published and the user explicitly does not want migration/legacy docs.
- If old files remain temporarily during implementation, they MUST NOT remain in the sidebar or active internal links in the completed state.

# Invariants

1. The docs site title MUST remain `Superfunctions`.
2. The top-level sidebar order MUST be stable and exact.
3. Every package in the package catalog MUST have exactly one package page and exactly one category assignment.
4. No package page may use known placeholder prose such as:
   - `Reference and usage guidance`
   - `Production wiring example`
   - `Verify package versions are aligned with your lockfile`
   - `Configure this package with explicit environment and observability settings`
5. No example may use monorepo-relative imports or nonexistent package names.
6. No active root docs route may expose migration, deprecation, or release-note content.
7. Internal links MUST be updated in the same phase that changes route structure.

# Security

1. Docs content MUST remain safe for public viewing.
2. No page may include real secrets, private keys, or internal-only operational procedures.
3. Examples MUST use placeholder credentials such as `your-client-id` and MUST NOT use real tokens.
4. Ecosystem links MUST point only to public routes or public repository paths.

# Limits / caps

1. Start Here pages MUST contain at least 400 prose words each, excluding code fences.
2. Category overview pages MUST contain at least 250 prose words each, excluding code fences.
3. TypeScript package pages MUST contain at least:
   - one install block,
   - two TypeScript/TSX/JavaScript code fences,
   - 350 prose words excluding code fences.
4. Python package pages MUST contain at least:
   - one install block,
   - two Python code fences,
   - 300 prose words excluding code fences.
5. Adapter pages MUST include one chooser/comparison artifact (table, checklist, or matrix).
6. Package pages MUST contain at least two cross-links to related packages or category pages.

# Observability

1. The docs workspace MUST provide local verification commands for:
   - catalog/taxonomy validation
   - content quality validation
   - code-snippet validation
   - link validation
   - docs build
2. Validation scripts MUST emit deterministic JSON so failures can be inspected in CI or local runs.
3. Error codes MUST be stable and documented in the scripts.

# Compatibility / versioning strategy

1. The implementation MAY change routes and sidebar structure because the root docs are pre-release.
2. The completed state MUST not preserve old migration/deprecation docs just for backwards compatibility.
3. Internal links, landing-page cards, and category references MUST be updated in the same implementation series so no broken user journey remains.

# Undefined / Explicitly user-deferred only

1. Versioned docs are undefined and not required.
2. Translated docs are undefined and not required.
3. Search ranking or docs search UX changes are undefined and not required.
4. Migration guides, legacy notes, deprecation notices, and release-note sections are explicitly excluded by user request.
