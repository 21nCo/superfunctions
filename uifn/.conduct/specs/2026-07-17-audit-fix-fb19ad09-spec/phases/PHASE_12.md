# PHASE_12 — Complete Svelte adapter and compound API

## Objective

Deliver complete Svelte 5-native compounds for every stable primitive from controllers and DOM services.

## Entry

- Phases 06–10 pass.
- Svelte 5 package/snippet/binding conventions have a focused API/type review.

## Requirements

- `SVELTE-001`.

## Work

1. Generate/implement every anatomy component, context, action, snippet/render contract, and documented binding from catalog/controller parts.
2. Bind reactive props through `controller.update` without service recreation; ensure subscriptions/effects/actions tear down once.
3. Remove calls to legacy `createAccordion`, `createCombobox`, other old machines, and framework-local focus/layer/position/presence/form behavior.
4. Prove Svelte 5 SSR/hydration, rune updates, snippets, bindings, actions, portals, forms, ID stability, error/unmount cleanup, and source/package equivalence.
5. Publish compiled JS, declarations and correct Svelte metadata/exports; remove raw repository TypeScript entrypoints.

## Required evidence

- `TV-SVELTE-001-P/N` plus every applicable primitive vector through actual public Svelte compounds.
- Packed-tarball clean-consumer tests and service/effect instance counters across reactive updates.
- Seeded raw-source export and controller-recreation defects are caught.

## Exit gate

Svelte inventory/anatomy/features match catalog, packed consumption is production-valid, and no update recreates behavior or duplicates resources.

## Do not

- Do not expose repository source paths as distribution contracts.
- Do not implement missing core behavior in Svelte actions.

## Handoff

Phase report records compiled exports, Svelte version, lifecycle evidence, exceptions, and semantic traces.
