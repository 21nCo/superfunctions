# SPEC

## Metadata

- Timestamp: `2026-03-25T13:07:36Z`
- agent_name: `spec`
- model: `GPT-5 Codex`
- launcher: `Codex Desktop`
- workspace/project path: `docsfn`
- OS + shell: `Darwin arm64`, `/bin/zsh`
- repo metadata:
  - repo root: `.`
  - branch: `HEAD` (detached)
  - commit: `ca86e25e6faf11da93e390c18dad8ae5f22b6f69`
  - dirty worktree: `yes (8 entries)`
- spec_folder: `2026-03-25-audit-fix-k6m3p9r2-spec`
- spec_folder path: `docsfn/.conduct/specs/2026-03-25-audit-fix-k6m3p9r2-spec`
- spec_type: `audit-fix`
- spec_id: `k6m3p9r2`
- input paths read:
  - user thread request for a detailed production-readiness fix spec
  - `$CODEX_HOME/skills/spec/SKILL.md`
  - `docsfn/.conduct/audits/2026-03-25-r8m4p2q7-full-audit.md`
  - `docsfn/.conduct/specs/2026-03-20-audit-fix-a27uykdy-spec/REQUIREMENTS.md`
  - `docsfn/.conduct/specs/2026-03-22-new-v7k2m9x4-spec/REQUIREMENTS.md`
  - `docsfn/README.md`
  - `docsfn/next/README.md`
  - `docsfn/sveltekit/README.md`
  - `docsfn/.conduct/tracker.csv`
- audit reference:
  - audit path: `docsfn/.conduct/audits/2026-03-25-r8m4p2q7-full-audit.md`
  - related prior spec folders:
    - `2026-03-20-audit-fix-a27uykdy-spec`
    - `2026-03-22-new-v7k2m9x4-spec`

## Overview

Project name: `docsfn`

One-sentence goal:

`docsfn` MUST close every remaining gap called out by the 2026-03-25 production-readiness audit so that it can replace Fumadocs across repo docs sites, with verified React and Svelte parity, accurate public docs, and a release gate that proves the claim.

Target users:

- `docsfn` maintainers
- Superfunctions package teams migrating `datafn/docs`, `searchfn/docs`, and sibling docs apps
- External consumers who follow the published `@docsfn/*` package docs

Target environments:

- Node `18+`
- npm workspaces / Turbo monorepo execution
- React `18` and `19`
- Next.js App Router `15`
- Svelte `4` and `5`
- SvelteKit `2`
- local development, local release gating, and CI execution

Languages/packages required:

- TypeScript
- Svelte
- React
- `@uifn/*`
- `@searchfn/client`
- `@searchfn/adapter-memory`
- `@searchfn/core`
- optional `authfn` / `watchfn` integrations remain supported

Existing systems it MUST integrate with:

- canonical repo docs fixtures under `docsfn/test-fixtures/repo/datafn-docs` and `docsfn/test-fixtures/repo/searchfn-docs`
- `docsfn/docs`
- `docsfn/examples/next-docs-site`
- `docsfn/examples/sveltekit-docs-site`
- `@docsfn/core`, `@docsfn/provider-fs`, `@docsfn/react`, `@docsfn/svelte`, `@docsfn/next`, `@docsfn/sveltekit`, `@docsfn/cli`
- `@searchfn/client`, `@searchfn/adapter-memory`, `@searchfn/core`

Data model summary:

- `DocsConfig`
- `DocsManifest`
- `DocsSearchArtifact`
- `CompiledContentArtifact`
- `CompiledContentBlock`
- `CanonicalOpenApiReference`
- `Sidebar`, `DocsPageSurface`, `Breadcrumb`, `Pagination`

Security model:

- public docs by default
- optional `public` / `private` / `mixed` route auth
- unsafe executable HTML blocked by default
- search / analytics / diagnostics MUST redact secrets and protected content

Performance constraints:

- deterministic build artifacts
- no per-request recompilation of already-known docs content in dogfood or example apps
- release gate MUST be runnable locally and in CI from a clean checkout
- search artifact MUST remain bounded by configured `maxArtifactBytes`

Non-goals:

- no hosted CMS product in this spec
- no WYSIWYG authoring UI
- no interactive “Try it” OpenAPI console
- no visual redesign of docsfn beyond what is required to keep current docs layouts functional

Hard constraints:

- no broad source rewrites to canonical fixture docs are allowed to achieve migration parity
- public guides MUST use only supported public APIs and repo-relative commands
- the same fixture content MUST produce equivalent user-facing semantics in React and Svelte
- unsupported content MUST fail closed with diagnostics; raw-source fallback is forbidden

Assumptions:

1. All previously implemented behavior that already passed the 2026-03-25 audit remains in force unless this spec explicitly supersedes it.
2. Repo-wide replacement readiness targets in-repo docs sites first, but public package imports and guides still MUST be correct because other teams will rely on them.
3. It is acceptable to add new package exports, helper APIs, tests, and build-time tooling if they are deterministic and documented.

## Glossary

- **Canonical fixture**: a frozen copy of a real repo docs tree used for proof, especially `datafn-docs` and `searchfn-docs`.
- **Compatibility construct**: syntax that exists in current Fumadocs-authored content and MUST migrate without source rewrites, including `meta.json`, `Tabs` / `Tab`, Mermaid fences, and documented frontmatter.
- **Compiled content artifact**: the normalized, trusted block model produced from markdown/MDX input and consumed by framework renderers.
- **Render parity**: the requirement that React/Next and Svelte/SvelteKit expose the same user-facing semantics for the same compiled content.
- **Raw-source fallback**: rendering original source text or opaque raw block bodies instead of functional UI or explicit diagnostics. This spec forbids it for supported constructs.
- **API-markdown page**: a hand-written markdown page that belongs to the API reference information architecture, such as package API reference pages under `/docs/api/**`.
- **API-openapi route**: a route generated from a normalized OpenAPI source.
- **Public import contract**: the exact package exports and import paths that docs, examples, and users are allowed to rely on.
- **Proof route**: a deterministic example-site route used by tests and release-gate checks to prove behavior.
- **Bootstrap environment**: a clean repo checkout after documented install steps, with no hidden machine-specific tooling.
- **Adapter-based search runtime**: the current monorepo `searchfn` architecture centered on `@searchfn/client` plus adapter packages. This is the canonical search integration model for this spec.

## Goals / Non-goals

### Goals

1. `docsfn` MUST preserve the current passing config, routing, navigation, search, blog, embedded, security, and OpenAPI behavior from the audited baseline.
2. `docsfn` MUST fix renderer parity so real canonical fixture pages with Tabs, Mermaid, and component blocks render functionally in both frameworks.
3. `docsfn` MUST make the Svelte package and guides safe to consume through public imports only.
4. `docsfn/docs` MUST become a truthful dogfood site that uses shipped package layers, uses a consistent API model, and does not rely on per-request compilation.
5. The example apps and release gate MUST become trustworthy proof, not shallow build smoke tests.

### Non-goals

1. This spec does not define a hosted documentation service.
2. This spec does not define live content editing workflows.
3. This spec does not require a new visual identity beyond parity and correctness.

## Public API

### Config additions

```ts
export type DocsSearchScope = "docs" | "api" | "blog";

export interface DocsSearchRouteScopeOverride {
  pattern: string; // normalized route glob, e.g. "/docs/api/**"
  scope: DocsSearchScope;
}

export interface DocsSearchConfig {
  enabled?: boolean;
  scopes?: DocsSearchScope[];
  bodyIndexing?: "full" | "summary" | "disabled";
  maxArtifactBytes?: number;
  routeScopeOverrides?: DocsSearchRouteScopeOverride[];
}
```

`routeScopeOverrides` is additive. It MUST NOT change routing. It only changes search-scope assignment for eligible routes.

### Compiled content model

```ts
export interface CompiledContentArtifact {
  framework: "react" | "svelte";
  renderModelVersion: 2;
  source: string;
  transformedSource?: string;
  toc: DocHeading[];
  blocks: CompiledContentBlock[];
  componentsUsed: string[];
}

export type CompiledContentBlock =
  | CompiledHeadingBlock
  | CompiledParagraphBlock
  | CompiledListBlock
  | CompiledTableBlock
  | CompiledCodeBlock
  | CompiledMermaidBlock
  | CompiledCalloutBlock
  | CompiledTabsBlock
  | CompiledComponentBlock;

export interface CompiledMermaidBlock {
  type: "mermaid";
  id: string;
  code: string;
}

export interface CompiledTabsBlock {
  type: "tabs";
  items: string[];
  tabs: Array<{
    value: string;
    label?: string;
    source: string;
    nodes: CompiledContentBlock[];
  }>;
}

export interface CompiledComponentBlock {
  type: "component";
  name: string;
  props: Record<string, string | number | boolean>;
  source: string;
  children: CompiledContentBlock[];
}
```

The block model MUST preserve renderable child structure for tabs and components. Storing only raw body strings is forbidden for supported constructs.

### Search scope resolution helper

```ts
export function resolveSearchScopeForRoute(input: {
  route: string;
  kind: "page" | "api" | "post";
  defaultScope: DocsSearchScope;
  frontmatter?: Record<string, unknown>;
  routeScopeOverrides?: DocsSearchRouteScopeOverride[];
}): DocsSearchScope;
```

Resolution order MUST be:

1. explicit `frontmatter.searchScope` when valid
2. first matching `routeScopeOverrides` entry in config order
3. collection/kind default

### Search runtime integration contract

- `docsfn` MUST treat the current `@searchfn/*` adapter/client architecture as the canonical search implementation surface.
- `docsfn` MUST NOT depend on legacy bare-package `searchfn` exports as a normative runtime contract for this spec.
- `docsfn` search artifact generation remains owned by `docsfn/core`; runtime hydration MAY use an adapter-backed client or helper built on the current `@searchfn/*` package family.
- If `docsfn` requires an ephemeral in-memory search helper with deterministic artifact hydration semantics, that helper MUST live in the current `searchfn` workspace surface rather than as a duplicate implementation inside `docsfn`.

### Compiled content cache helper

```ts
export function buildCompiledContentMap(input: {
  manifest: DocsManifest;
  framework: "react" | "svelte";
  compatPreset: DocsCompatPreset;
  include?: Array<"pages" | "posts">;
}): Record<string, CompiledContentArtifact>;
```

The returned object MUST be keyed by canonical manifest entry id.

### React render contract

```ts
export interface DocsContentProps {
  compiled: CompiledContentArtifact;
  components?: Record<string, React.ComponentType<{ children?: React.ReactNode }>>;
  mermaidRenderer?: React.ComponentType<{ id: string; code: string }>;
  onUnresolvedComponent?: (name: string) => never;
}
```

`DocsContent` MUST throw `DOCS_COMPONENT_UNRESOLVED` for unresolved component blocks unless the block is explicitly unsupported at compile time and already rejected.

### Svelte render contract

```ts
export interface SvelteDocsContentProps {
  compiled: CompiledContentArtifact;
  components?: Record<string, ComponentType | undefined>;
  mermaidRenderer?: ComponentType<{ id: string; code: string }>;
}
```

The package `@docsfn/svelte` MUST expose browser-safe public imports for:

- `@docsfn/svelte`
- `@docsfn/svelte/DocsContent.svelte`
- `@docsfn/svelte/DocsLayout.svelte`
- `@docsfn/svelte/DocsSidebar.svelte`
- `@docsfn/svelte/DocsToc.svelte`
- `@docsfn/svelte/DocsSearch.svelte`
- `@docsfn/svelte/TopBar.svelte`
- `@docsfn/svelte/Pagination.svelte`
- `@docsfn/svelte/Breadcrumbs.svelte`
- `@docsfn/svelte/VersionSwitcher.svelte`
- `@docsfn/svelte/EmbeddedPage.svelte`
- `@docsfn/svelte/SidebarGroup.svelte`
- `@docsfn/svelte/ApiReferenceRenderer.svelte`
- `@docsfn/svelte/theme.css`
- `@docsfn/svelte/theme-base.css`

### Release gate summary

```ts
export interface DocsReleaseGateSummary {
  schemaVersion: 1;
  status: "pass" | "fail";
  checks: Array<{
    id: string;
    status: "pass" | "fail";
    durationMs: number;
    details?: string;
  }>;
  fixtures: Array<{
    id: string;
    framework: "next" | "sveltekit";
    route: string;
    status: "pass" | "fail";
  }>;
}
```

`docsfn/scripts/release-gate.mjs` MUST emit this summary deterministically at the end of every run.

## Data Formats / Protocol

### Search artifact scope semantics

- Search documents derived from markdown pages MAY have scope `api` when `frontmatter.searchScope` or `search.routeScopeOverrides` assigns it.
- A document route MUST belong to exactly one search scope.
- Scope assignment MUST NOT mutate the route path or manifest page kind.

### Search artifact/runtime boundary

- `search.json` MUST remain a deterministic `docsfn`-owned artifact describing normalized docs search documents and scopes.
- Runtime query behavior MUST be implemented through the current `@searchfn/*` client/adapter model, not by binding `docsfn` to legacy bare-package engine exports.
- Any artifact-hydration bridge required between `docsfn` and `searchfn` MUST be deterministic, versioned, and tested from a clean workspace checkout.
- If current `@searchfn/*` surfaces are missing a required in-memory hydration API, the missing capability MUST be added to the `searchfn` workspace package that owns that concern instead of duplicated in `docsfn`.

### Diagnostics

The following codes are newly required or newly constrained by this spec:

- `DOCS_COMPONENT_UNRESOLVED`
- `DOCS_RENDER_FALLBACK_FORBIDDEN`
- `DOCS_SEARCH_SCOPE_INVALID`
- `DOCS_PUBLIC_API_INVALID`
- `DOCS_RELEASE_ENV_INVALID`
- `DOCS_RELEASE_GATE_FAILED`

These codes MUST appear in `diagnostics.json` or release-gate output with stable ordering and deterministic messages.

### Documentation contract check output

The docs contract check MAY emit a JSON artifact, but if it does, it MUST contain:

```json
{
  "schemaVersion": 1,
  "status": "pass",
  "violations": []
}
```

Violations MUST be sorted deterministically by file path and message.

## Semantics

### Compilation and rendering

1. The compiler MUST normalize supported compatibility constructs into a block tree that preserves nested renderable children.
2. Tabs MUST carry compiled child nodes per tab, not only raw strings.
3. Component blocks MUST carry compiled children and normalized props.
4. Mermaid blocks MUST preserve source text as data and MUST render through an explicit renderer contract in framework packages.
5. For supported constructs, runtime renderers MUST produce functional UI. Literal source text is forbidden.

### Component resolution

1. In `compat.preset: "fumadocs-v15"`, known Fumadocs compatibility constructs MUST transform to canonical blocks.
2. Unsupported compatibility constructs MUST fail compilation with `DOCS_COMPAT_UNSUPPORTED`.
3. In native mode, unresolved custom component tags MUST fail compilation or render setup with `DOCS_COMPONENT_UNRESOLVED`.
4. Reference renderers MUST NOT silently substitute raw source containers for unresolved content.

### Search scope assignment

1. OpenAPI-derived routes default to `api`.
2. Blog posts default to `blog`.
3. Docs pages default to `docs`.
4. Pages under API information architecture MAY become `api` scope by `frontmatter.searchScope` or `routeScopeOverrides`.
5. `docsfn/docs` MUST choose one canonical approach and document it; this spec chooses `routeScopeOverrides` for hand-written package API pages under `/docs/api/**`.

### Search implementation strategy

1. `docsfn/core` owns deterministic search document normalization, scope assignment, diagnostics, and artifact serialization.
2. Search query/runtime behavior MUST be wired through the current `searchfn` adapter/client architecture.
3. Example apps, dogfood site, and release-gate verification MUST all exercise the same search runtime path.
4. Legacy `searchfn` package exports MAY be referenced only for migration comparison during investigation; they are NOT the production implementation target for this spec.

### API reference model

1. Hand-written package API reference pages and OpenAPI-derived pages MAY coexist.
2. They MUST share API navigation/search semantics, but they MUST NOT produce route collisions.
3. Public docs MUST describe them consistently.

### Dogfood and example site caching

1. `docsfn/docs` and both example apps MUST compile page/post content once per loaded manifest snapshot and reuse it.
2. Per-request recompilation of immutable route content is forbidden in the proof paths.
3. Cache keys MUST be deterministic and derived from manifest entry id + compat preset + framework.

### Documentation correctness

1. Public READMEs and guides MUST use only exported public import paths.
2. Public commands MUST be repo-relative or package-manager-standard; machine-specific absolute paths are forbidden.
3. Public docs MUST not describe `/api/[...slug]` if the shipped site and tests use `/docs/api`.

### Release gate

1. The release gate MUST preflight environment prerequisites before attempting builds.
2. The release gate MUST run build, package, component, example, and fixture parity checks.
3. It MUST block on renderer parity failures, not just route/build smoke failures.

## Invariants

1. The same canonical fixture page MUST produce semantically equivalent rendered output in React and Svelte.
2. `manifest.json`, `search.json`, `compat-report.json`, and release-gate summary output MUST remain deterministic for unchanged inputs.
3. No reference renderer MAY emit raw unsupported source text for a construct that docsfn claims to support.
4. No public documentation MAY require `node_modules/.../src` imports.
5. No public documentation MAY include user-machine-specific absolute paths.
6. Search scope overrides MUST be pure classification rules; they MUST NOT mutate routes, page ids, or sidebar topology.

## Security

1. Existing unsafe HTML blocking remains mandatory.
2. Mermaid content MUST be treated as plain diagram source, not executable HTML.
3. Search summaries, diagnostics, release summaries, and docs contract reports MUST NOT log full protected page bodies or secrets.
4. Unresolved custom components MUST fail closed; they MUST NOT render raw body text that could leak unexpected content.

## Limits / caps

1. `search.routeScopeOverrides` MUST contain at most `64` entries.
2. A single route MUST match at most one effective override after resolution; ambiguous matches MUST fail validation with `DOCS_SEARCH_SCOPE_INVALID`.
3. Compiled content cache cardinality MUST be bounded by the number of included manifest entries.
4. Proof routes in example apps MUST include at least:
   - one Tabs-heavy docs page
   - one Mermaid docs page
   - one API reference route
   - one blog post route
   - one embedded page route

## Observability

1. `docsfn build` and `docsfn validate` MUST continue to emit `diagnostics.json`.
2. The release gate MUST emit a deterministic summary artifact and a human-readable console summary.
3. Docs contract checks MUST report exact file paths and invalid import/command strings.
4. Observability outputs MUST NOT include secrets, cookies, raw tokens, or protected content bodies.

## Compatibility / versioning strategy

1. Existing public config fields remain valid.
2. `search.routeScopeOverrides` is additive and backwards-compatible.
3. `renderModelVersion: 2` is the required compiled-content contract for this spec’s implementation.
4. Existing `/docs` route semantics remain the canonical public route contract.
5. Existing React/Next and Svelte/SvelteKit supported version ranges remain in force and MUST be reflected in peer dependencies and docs.
6. Search integration for this spec is defined against the current `@searchfn/*` workspace packages rather than the legacy bare `searchfn` package surface.

## Undefined / Explicitly user-deferred only

The following are undefined and therefore NOT required by this spec:

1. Interactive OpenAPI “Try it” execution UI.
2. Hosted content editing workflows.
3. A theme toggle beyond `prefers-color-scheme`.
4. CMS authoring UX beyond provider contracts already defined in prior specs.
