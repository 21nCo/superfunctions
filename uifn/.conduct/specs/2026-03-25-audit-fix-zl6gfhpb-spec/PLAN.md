# Architecture Sketch

Production-ready `uifn` in this bundle is organized into six responsibility layers:

1. Release contract layer
   - package names, export maps, pack output, root/package docs, support matrix, release manifest, consumer smoke
2. Core semantic layer
   - deterministic ID utilities, canonical error helpers, shared primitive state/interaction semantics
3. React adapter layer
   - framework bindings, `asChild` and ref ergonomics, SSR/hydration-safe ARIA linking, adapter regression tests
4. Svelte adapter layer
   - framework bindings, deterministic IDs, warning-free builds, controlled reactivity, modal/keyboard parity
5. Evidence layer
   - automated coverage, scale tests, manual accessibility evidence, release evidence validation
6. Release gate layer
   - one-command verification that fails on semantic, documentation, evidence, or compatibility regressions

# Dependency Graph

```text
Phase 00 contract + gate scaffolding
  -> Phase 01 core deterministic IDs + canonical errors
    -> Phase 02 core disclosure/form ownership
    -> Phase 03 core popup/menu/select/range/scroll ownership
      -> Phase 04 React infrastructure conformance
      -> Phase 06 Svelte infrastructure conformance
        -> Phase 05 React family completion
        -> Phase 07 Svelte family completion
          -> Phase 08 docs/helper/boundary truth
            -> Phase 09 QA + accessibility + consumer smoke
              -> Phase 10 release-candidate closure
```

# Phases Overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `PHASE_00` | Lock the release contract and verification scaffolding | Updated truth-source docs, gate/report scaffolding, consumer smoke entry point | `npm run verify:uifn-release -- --dry-run` plus docs/export diff review |
| `PHASE_01` | Repair core deterministic ID and canonical error infrastructure | Shared ID helpers, adapter assertion helpers, error-code normalization | core unit tests and package typecheck |
| `PHASE_02` | Bring core disclosure and form families to the current contract | Core ownership for disclosure/collection/form state semantics | core family tests |
| `PHASE_03` | Bring core popup/menu/select/range/scroll families to the current contract | Core ownership for modal, popup, select, combobox, range, and geometry behavior | core family tests plus focused vectors |
| `PHASE_04` | Make React infrastructure conform to the core and determinism contracts | React ID, context-error, SSR, and multi-instance infrastructure | React build/test/typecheck plus SSR regression tests |
| `PHASE_05` | Complete React family-level semantic parity | React family bindings match the core contract and remove known drift | React integration and family regression tests |
| `PHASE_06` | Make Svelte infrastructure conform to the determinism and tooling contracts | No random IDs, no warning suppression, canonical context assertions, stable declarations | Svelte build/test/typecheck without suppressed warnings |
| `PHASE_07` | Complete Svelte family-level semantic parity | Svelte keyboard, modal, cleanup, and controlled-state behavior matches the core contract | Svelte integration and family regression tests |
| `PHASE_08` | Close helper, docs, and package-boundary truth gaps | Virtualized scale closure, root spec cleanup, files/vue boundary truth | helper tests, docs diff, pack review |
| `PHASE_09` | Close automated QA and real manual accessibility evidence | Coverage matrix closure, real-browser manual evidence, consumer smoke artifacts | full test suite, evidence review, smoke workspace pass |
| `PHASE_10` | Produce a valid release candidate | Final gate enforces package checks, evidence checks, and compatibility policy | `npm run verify:uifn-release` on a clean local install |

# Definition of Done

No phase is complete unless its listed verification steps pass locally.

No overall implementation is complete until:

- every `P0` and `P1` requirement in this bundle passes,
- the GA React and Svelte adapters satisfy deterministic and modal semantics,
- root/package docs match the shipped API,
- the release gate passes without suppressed exceptions, and
- real manual accessibility evidence is present and valid.
