# PHASE_13 — Complete Solid adapter and compound API

## Objective

Bring Solid from partial/generic coverage to equal first-class compound coverage for all stable primitives.

## Entry

- Phases 06–10 pass.
- Solid composition/reactivity/SSR conventions have a focused API/type review.

## Requirements

- `SOLID-001`.

## Work

1. Replace generic headless factories with typed native Solid compounds for every catalog anatomy and feature.
2. Bind controllers through fine-grained accessors/stores without stale destructuring, service recreation, whole-tree invalidation, or owner-root leaks.
3. Use shared DOM services for portals, focus, layers, positioning, presence, forms, and cleanup; delete local equivalents.
4. Prove current Solid 1.x SSR/hydration, owner disposal, portals, controlled updates, forms, dynamic collections, unmount races, and source/package consumers.
5. Validate complete inventory/API extraction, peers, tree shaking, and parity-ready trace output.

## Required evidence

- `TV-SOLID-001-P/N` plus every applicable primitive vector through actual public Solid compounds.
- Catalog-to-export exact match and seeded generic-factory/stale-reactivity mutations.
- Fine-grained render/update instrumentation and zero owned resources after owner disposal.

## Exit gate

Solid feature/anatomy coverage equals React/Svelte and every public tree reproduces golden behavior without generic substitutes or reactivity defects.

## Do not

- Do not call a generic factory a complete compound API.
- Do not destructure reactive inputs in ways that freeze values.

## Handoff

Phase report records exact Solid version, inventory delta from baseline, reactivity metrics, exceptions, and semantic traces.
