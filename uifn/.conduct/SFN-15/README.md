# SFN-15: uifn Production Readiness Spec Bundle

This folder defines the full SFN-15 product and implementation specification for making `uifn` production-ready as a cross-framework UI primitive, component, pattern, registry, and Superfunction-backed UI system.

## Documents

- `SPEC.md` - canonical technical specification and public API contract.
- `REQUIREMENTS.md` - numbered requirements with acceptance criteria and test vector references.
- `TEST_VECTORS.md` - deterministic golden vectors and negative variants.
- `PLAN.md` - phased implementation strategy and dependency graph.
- `INTENT_AUDIT.md` - source intent inventory mapped to spec coverage.
- `subspecs/` - detailed sub-specifications for architecture, adapters, styling, catalog, patterns, registry, Storybook, testing, and release.
- `phases/` - executable phase work packages.
- `logs.csv` - append-only generation log for this bundle.

## Authoritative Inputs

- User direction in the SFN-15 planning thread.
- Side-chat note: Storybook as consumer-facing workshop/test surface and Bit concepts as component supply-chain model.
- Side-chat note: styling system should be CSS-variable/design-token-first, with Tailwind generated from the contract.
- Live Coss UI documentation snapshot taken on 2026-06-27 from `https://coss.com/ui/docs`.

## Scope Position

SFN-15 is not an MVP. It specifies the complete target architecture and implementation plan for:

- unstyled primitives across React, Svelte, Vue, Solid, and Angular,
- styled base components covering the Coss UI catalog,
- semantic design tokens, runtime theming, Tailwind integration, and recipes,
- source-installable registry items and package imports,
- Storybook workshop/test/docs integration,
- Bit-like component lifecycle metadata without adopting Bit as a required toolchain,
- Superfunction-backed patterns for `authfn`, `plugfn`, `filefn`, and `billfn`,
- production release gates with accessibility, interaction, visual, SSR, packaging, and manifest validation.
