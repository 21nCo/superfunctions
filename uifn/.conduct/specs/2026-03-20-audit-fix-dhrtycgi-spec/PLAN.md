# Architecture Sketch

Production-ready `uifn` is organized into five responsibility layers:

1. Release contract layer
   - Package names, export maps, README/install docs, support matrix, changelogs, license consistency, pack hygiene
2. Shared core semantic layer
   - `@uifn/core` primitives, deterministic ID/focus/position/presence utilities, canonical error model
3. React adapter layer
   - Framework bindings, `asChild`/ref ergonomics, SSR-safe hooks, adapter integration tests
4. Svelte adapter layer
   - Framework bindings, prop/event/slot typing, reactive controlled-mode handling, toolchain alignment
5. Verification layer
   - Unit/integration/a11y tests, pack/install smoke checks, release-gate orchestration

# Dependency Graph

```text
Phase 00 release contract baseline
  -> Phase 01 core package surface + utilities
    -> Phase 02 core disclosure/form/range semantics
    -> Phase 03 core popup/menu/select/combobox/scroll semantics
      -> Phase 04 React adapter conformance
      -> Phase 05 Svelte adapter conformance
        -> Phase 06 docs/files/vue/support-matrix harmonization
          -> Phase 07 automated QA + accessibility closure
            -> Phase 08 release-candidate verification
```

# Phases Overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `PHASE_00` | Normalize public package contract and release scaffolding | Canonical package names, export-map plan, support matrix, release scripts scaffold | `npm pack --dry-run`, docs diff review, release-gate scaffold invocation |
| `PHASE_01` | Repair core package surface and shared utilities | Stable exports for `aria/state/utils`, deterministic IDs, canonical errors, shared utility modules | core unit tests, clean type/build output |
| `PHASE_02` | Bring core disclosure/form/range families to spec | Stable core semantics for disclosure, form, and range families | core family tests + shared vectors |
| `PHASE_03` | Bring core popup/menu/select/combobox/scroll families to spec | Shared popup positioning, menu/select/combobox/scroll behavior | core family tests + geometry/navigation vectors |
| `PHASE_04` | Make React a GA adapter | React API parity, `asChild`, ref correctness, SSR-safe hooks, green local package verification | React build/test/lint/pack + SSR smoke |
| `PHASE_05` | Make Svelte a GA adapter | Svelte reactive controlled behavior, declarations, supported toolchain, green local package verification | Svelte build/test/lint/pack + warning-free build |
| `PHASE_06` | Align docs, support matrix, Vue/files boundary | Truthful READMEs/spec/support matrix/license/changelog/files scope decision | docs smoke review + pack verification |
| `PHASE_07` | Close automated QA and accessibility gaps | Core/React/Svelte coverage matrix, automated axe smoke, manual checklist templates | test suite + a11y smoke + checklist artifacts |
| `PHASE_08` | Produce a release-candidate gate | One-command verification and final support-matrix enforcement | `npm run verify:uifn-release` on clean install |

# Definition of Done

No phase is complete unless its listed verification steps pass locally, and no overall implementation is complete until all release-blocking packages pass the canonical release-gate suite with truthful docs and pack output.
