# Issue Completion: SFN-20 MDFN Markdown Authoring Platform

## Metadata

- **Timestamp**: 2026-08-12T15:28:29Z
- **Agent**: unknown-agent
- **Model**: GPT-5 (Codex)
- **Launcher**: Codex Desktop
- **Workspace**: isolated `mdfn-SFN-20` worktree
- **Git state**: detached HEAD at `8dddd865ee9b86571c70db87efd918152cf682fb`
- **Base ref**: `sf-next/next` at `8dddd865ee9b86571c70db87efd918152cf682fb`
- **Dirty status**: complete local SFN-20 implementation; uncommitted and unstaged
- **Issue**: [SFN-20](https://linear.app/21n/issue/SFN-20/build-mdfn-as-the-superfunctions-markdown-authoring-platform)
- **Workflow**: `21n/work-linear-issue@1.0.1`

## Issue Summary

Build MDFN as the framework-agnostic Markdown authoring platform for the Superfunctions ecosystem. The result must provide one shared document state and transaction contract across source, visual, preview, server, collaboration, framework, UI, testing, registry, and ecosystem-integration packages while preserving Markdown source safely and predictably.

## Status

PASS

The complete local implementation and its verification are finished. Publication remains intentionally gated on explicit user approval; no branch, commit, staging operation, push, or pull request was created.

## Product Decisions Implemented

1. CommonMark is the baseline syntax and GFM is the default profile.
2. Source preservation has three explicit guarantees: exact when untouched, semantic when a full rewrite is necessary, and bounded to the touched source region for normal edits.
3. Raw HTML is disabled by default; enabling it still requires a sanitizer before rendered output is returned.
4. MDFN owns the headless editing platform and framework adapters; UIFn owns reusable application chrome.
5. Stable framework and UI packages are separated from optional collaboration, platform, and ecosystem bridges.
6. The package graph is explicit, machine-verifiable, and guarded against framework peer-dependency leakage.

## Requirements and Evidence

### 1. Complete package architecture

- **Status**: PASS
- **Evidence**: `mdfn/package-graph.json` defines 24 publishable packages in an acyclic graph: 17 stable packages and 7 optional packages.
- **Verification**: `node scripts/verify-mdfn-package-graph.mjs` passed and reported React, Svelte, and Solid as the supported framework targets.

### 2. Shared document state and source-preserving Markdown

- **Status**: PASS
- **Evidence**: `@mdfn/core` provides immutable editor state, transactions, history, snapshots, selection, anchors, extension registration, and controller lifecycle. `@mdfn/markdown` provides CommonMark/GFM parsing, UTF-16 source spans, opaque syntax preservation, diagnostics, limits, exact untouched serialization, and touched-region edits.
- **Verification**: core and Markdown build, typecheck, and 9 focused tests passed; parity and large-document behavior are also exercised by `@mdfn/testing`.

### 3. Secure rendering and browser surfaces

- **Status**: PASS
- **Evidence**: `@mdfn/render` provides bounded HTML and text extraction with protocol allowlists, obfuscated-URL rejection, raw-HTML controls, and sanitizer requirements. `@mdfn/dom` implements the visual editing surface; `@mdfn/source` implements source editing and secure preview.
- **Verification**: render, DOM, and source package builds, typechecks, and 9 tests passed.

### 4. Framework-agnostic adapters and UIFn chrome

- **Status**: PASS
- **Evidence**: React, Svelte, and Solid adapters use the same controller contract and expose source, visual, and preview modes. Shared toolbar semantics live in `@mdfn/components`; framework-specific chrome uses the corresponding UIFn package. Toolbar commands route to the active surface.
- **Verification**: all framework and component packages built and typechecked; adapter lifecycle tests passed; clean tarball consumers for React, Svelte, and Solid installed and completed production builds.

### 5. Extensions, registry, testing, and facade

- **Status**: PASS
- **Evidence**: the extension contract supports syntax, commands, render hooks, migrations, dependencies, and capability metadata. CommonMark, GFM, callout, and diagram extensions are provided. Registry profiles resolve transitive dependencies. The testing package provides conformance, parity, and performance helpers. The `mdfn` facade exports the stable platform entrypoints.
- **Verification**: all related packages built and typechecked; executable suites passed; package-graph verification confirmed the dependency rules.

### 6. Optional platform capabilities

- **Status**: PASS
- **Evidence**: collaboration uses Yjs and awareness with schema checks and authorization hooks; client and server packages provide transport, persistence, history, optimistic concurrency, idempotency, authorization, and collaboration endpoints. The server internally wraps the supplied `@superfunctions/db` adapter with its own schema and enforces document scope before host authorization.
- **Verification**: collaboration, client, and server builds, typechecks, and 4 tests passed. Server package tarball dry-run passed.

### 7. Ecosystem bridges and direct consumers

- **Status**: PASS
- **Evidence**: FileFn, ContentFn, SearchFn, and AI bridges are implemented. DocsFn now uses MDFN for canonical Markdown parsing and render extraction. ContentFn has an explicit Markdown content kind and validates stored source. CmsFn Studio selects an MDFN-backed Markdown widget for Markdown fields.
- **Verification**: all bridge packages built, typechecked, and passed tests; DocsFn core passed 147 tests, ContentFn core passed 8 tests, ContentFn server passed 112 tests, and CmsFn Studio passed 50 tests.

### 8. Documentation, release inventory, and local-only delivery

- **Status**: PASS
- **Evidence**: root and package READMEs document usage and package boundaries. `mdfn/.conduct/MDFN-01/` contains the product, content-model, architecture, extension-contract, security, verification, and delivery specifications. Root workspaces, lockfile, scripts, and release inventory include every MDFN package.
- **Verification**: all 24 package dry-runs passed during the release verification; the five packages touched by final hardening were packed again successfully. Git whitespace validation passed. The worktree remains detached, dirty, uncommitted, and unstaged.

## Implementation Summary

### Stable packages

- `@mdfn/core`
- `@mdfn/markdown`
- `@mdfn/render`
- `@mdfn/extensions`
- `@mdfn/dom`
- `@mdfn/source`
- `@mdfn/adapter-kit`
- `@mdfn/react`
- `@mdfn/svelte`
- `@mdfn/solid`
- `@mdfn/components`
- `@mdfn/components-react`
- `@mdfn/components-svelte`
- `@mdfn/components-solid`
- `@mdfn/testing`
- `@mdfn/registry`
- `mdfn`

### Optional packages

- `@mdfn/collab`
- `@mdfn/client`
- `@mdfn/server`
- `@mdfn/filefn`
- `@mdfn/contentfn`
- `@mdfn/searchfn`
- `@mdfn/ai`

### Direct repository integrations

- DocsFn core: canonical MDFN parsing and render extraction.
- ContentFn core: explicit Markdown schema kind and validation.
- ContentFn server: MDFN-backed Markdown storage validation.
- CmsFn Studio: MDFN Markdown editor widget and field routing.
- Root repository: workspace registration, lockfile, release inventory, graph verifier, full verifier, and packed-consumer verifier.

## Verification Summary

Executed successfully from the isolated worktree root:

```bash
node scripts/verify-mdfn-package-graph.mjs
node scripts/verify-mdfn.mjs --skip-pack
node scripts/verify-mdfn.mjs --pack-only
npm run verify:mdfn-consumers
npm pack --dry-run --json --workspace=mdfn/markdown
npm pack --dry-run --json --workspace=mdfn/render
npm pack --dry-run --json --workspace=mdfn/testing
npm pack --dry-run --json --workspace=mdfn/server
npm pack --dry-run --json --workspace=mdfn/filefn
git diff --check
```

Results:

- Package graph: PASS, 24 packages, 17 stable, 7 optional.
- MDFN builds: PASS, 24/24.
- MDFN typechecks: PASS, 24/24.
- MDFN test commands: PASS, 24/24; 39 executable tests passed, with component-shell and facade packages covered through typechecking and packed consumer builds.
- Package dry-runs: PASS, 24/24 in the complete pack pass; final hardened packages repacked successfully.
- Clean packed consumers: PASS for React, Svelte, and Solid production builds.
- Framework isolation: PASS; consumer verification found no cross-framework peer pollution.
- Ecosystem regression tests: PASS, 317 tests across DocsFn core, ContentFn core, ContentFn server, and CmsFn Studio.
- Whitespace validation: PASS.
- Forbidden product-reference scan: PASS, no matches.

## Repository-Level Caveats

- The root Turbo typecheck cannot currently be used as evidence because the existing repository graph contains a ProbeFn workspace dependency cycle. This predates and is outside SFN-20.
- ContentFn server and CmsFn Studio are nested packages that are not root npm workspaces. Their direct standalone typecheck commands expose pre-existing unresolved local-package and unrelated test typing issues. Their full runtime suites passed with test-time source aliases, and the MDFN packages themselves passed clean typechecks.
- DocsFn core build emits pre-existing Rollup circular re-export warnings; its build and 147-test suite pass.
- `npm install --ignore-scripts` succeeds but reports existing repository audit advisories and a Node engine warning for an unrelated visualization dependency.

These caveats are verification gaps or pre-existing repository conditions, not known failures in the SFN-20 implementation.

## Side Effects and Publication State

- No branch was created.
- No files were staged.
- No commit was created.
- No remote branch was pushed.
- No pull request was created.
- No issue status transition was performed.

## Blockers

None for local implementation. Publication is awaiting explicit user approval under the selected workflow.
