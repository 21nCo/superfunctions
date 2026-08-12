# SFN-15 uifn Full Audit

## Metadata

- Audit timestamp: 2026-06-28T08:48:51Z
- Audit id: 2026-06-28-x1y2z3a4
- Agent name: Antigravity
- Model: Gemini 3.1 Pro (High)
- Workspace: repo root, project scope `uifn`
- Shell/OS: zsh on Darwin
- Git branch: `SFN-15`
- Git commit audited: `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Git status at audit time: modified/untracked files present in `.conduct/audits`

## Scope

User request: perform a thorough audit of the current `uifn` implementation against the `.conduct/SFN-15` spec.

Intent and spec sources audited:
- `uifn/.conduct/SFN-15/SPEC.md`
- `uifn/.conduct/SFN-15/REQUIREMENTS.md`
- `uifn/.conduct/SFN-15/subspecs/*.md`

Implementation sources audited:
- `uifn/**`
- `scripts/verify-uifn-*.mjs`

## Executive Summary

The implementation has established a broad SFN-15 scaffold: all 16 target packages exist, public package names align with the spec, and a release gate currently returns `ok: true`.

However, upon manual code inspection, the implementation is **not SFN-15 complete**. The automated release gate tests emit false positives by checking metadata descriptors and mock fixtures rather than the rendered component behaviors.

The most critical behavioral gaps identified are:
1. **Framework adapter conformance bypasses real frameworks**: Adapters use `createMinimalFixtureAdapter(...)` which tests core controllers via a core fixture, never exercising real React, Svelte, Vue, Solid, or Angular rendering logic.
2. **`@uifn/components` exports descriptors, not styled components**: The 45 Coss-compatible components return descriptor factories rather than framework-renderable components.
3. **Registry component manifests are planned placeholders**: The registry validation passes despite the 45 component manifests remaining under `status: "planned"` with placeholder stories, fixtures, and tests.
4. **Registry source install generates thin wrappers**: The CLI writes generated wrappers and `.uifn/lock.json`, failing to install real source files, `.uifn/registry.lock`, and `.uifn/selected-components.json` as the spec dictates.
5. **Partial SF-backed pattern coverage**: The detailed subspec lists 14 SF-backed variants, but only 7 are enforced in the implementation.
6. **Core part props drift**: The implementation uses `handlers` instead of the public shape `on` defined in SFN-15.
7. **Incomplete theming**: No `createBrandTheme` implementation exists. Contrast checks only validate three hard-coded pairs instead of full semantic groups.

Overall status: The project is a metadata-driven acceptance harness rather than a production-ready SFN-15 implementation.

## Top Findings

### P0 - Adapter conformance bypasses the real framework adapters
SFN-15 requires each adapter to expose a component API, headless attachment API, and a conformance test. Current framework conformance files (e.g., `uifn/react/src/conformance/react-conformance.ts`) all instantiate the adapter-kit's minimal fixture adapter (`createMinimalFixtureAdapter`). This means the suite passes without verifying the actual framework's public API behavior.

### P0 - `@uifn/components` is descriptor-level
SFN-15 requires styled packages for all 45 Coss-compatible components. Currently, files like `uifn/components/src/react/batch-a.ts` export descriptors (via `createFrameworkBatchAComponent`). These do not render real DOM elements or handle actual keyboard/a11y behaviors, meaning the required styled components remain unimplemented.

### P0 - Registry component manifests are placeholders
Scanning `uifn/registry/catalog/components/button.json` shows `status: "planned"` with placeholder fields. The `scripts/verify-uifn-catalog.mjs` verifier checks for metadata presence but does not verify implementation completeness, producing false confidence.

### P0 - Release gate gives false confidence
The `verify:uifn-release` command returned 80 passing checks, but deep inspection reveals:
- `scripts/verify-uifn-a11y.mjs` checks JSON metadata booleans, not actual ARIA attributes or screen-reader DOM output.
- `scripts/verify-uifn-visual.mjs` checks story matrix keys, not actual pixel differences.
- `scripts/verify-uifn-adapter.mjs` checks string tokens instead of hydrated framework behavior.

### P1 - Registry source install is non-compliant
The CLI's `addArtifact` (in `uifn/registry/src/add.ts`) dynamically creates files containing `export const uifnRegistryEntry = ...` rather than installing the actual source distribution. Furthermore, it creates a `.uifn/lock.json` file rather than `.uifn/registry.lock` and `.uifn/selected-components.json`.

### P1 - Core part props deviate from spec
The core cross-framework part contract (e.g. `uifn/core/src/parts.ts`) defines `handlers?: UIFnPartEventHandlers`, whereas the SFN-15 spec requires `on?: Record<string, UIFnEventHandler>`.

### P1 - SF-backed pattern coverage is incomplete
While the release gate successfully verified 7 panels (like `AuthFnAuthPanel` and `PlugFnOAuthConnectionsPanel`), it is missing the other 7 variants defined in the pattern subspec (such as `AuthFnSessionList` and `FileFnUploadProgressList`).

## Recommended Remediation Order

1. **Gate strictness**: Update release verification scripts to fail on `status: "planned"` and replace static metadata JSON checks with behavioral tests.
2. **Adapter conformance**: Remove `createMinimalFixtureAdapter` in favor of real framework instantiation and DOM assertion.
3. **Component rendering**: Implement actual styled components rather than metadata descriptor factories.
4. **Registry compliance**: Update CLI tooling to fetch real component source files and write spec-compliant lock files.
5. **Pattern completion**: Implement the remaining 7 SF-backed patterns to fulfill the detailed subspec.
6. **API alignment**: Rename `handlers` to `on` across core parts to conform with public API specs.
7. **Theming completion**: Introduce the `createBrandTheme` implementation and complete contrast validations.

## Final Assessment

The audited implementation is **not GA-candidate ready**. While the organizational scaffolding and testing harnesses exist, the system relies on mocked descriptors and placeholder data to pass its release gates. The `verify:uifn-release` signal is currently inaccurate and requires behavioral reinforcement.
