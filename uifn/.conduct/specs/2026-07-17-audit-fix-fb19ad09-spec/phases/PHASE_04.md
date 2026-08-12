# PHASE_04 — Controller, typed parts, environment, and legacy deletion

## Objective

Expose the final public controller facade over the private runtime, implement safe part composition and environment scope, and remove all legacy behavior APIs.

## Entry

- Phase 03 runtime and lifecycle/property suites pass.
- Public contract in `SPEC.md` has an API/type review before implementation is frozen.

## Requirements

- `ARCH-002`, `ARCH-003`, `PART-001`, `ENV-001`.

## Work

1. Implement uniform `UIFnController` status/state/snapshot/actions/parts/update/subscribe/destroy semantics, typed change metadata, destroyed behavior, and readonly snapshot/types.
2. Implement anatomy-specific part types and composition utilities for handler ordering/cancellation, invariant ownership, ref/class/style merging, IDs, ARIA, and data attributes.
3. Expand environment/scope injection for root/document/window, IDs, direction, locale, timezone, clock/scheduler, warnings, observers, and capabilities while keeping core DOM-free.
4. Delete public `StateMachine`, controller-adapter wrappers, local store utilities used as behavior runtimes, duplicate machine creators, wildcard legacy exports, and all internal consumers.
5. Write the breaking migration guide and compile-only consumer fixtures for removed and replacement APIs.

## Required evidence

- `TV-ARCH-002-P/N`, `TV-ARCH-003-P/N`, `TV-PART-001-P/N`, `TV-ENV-001-P/N`.
- Public API extractor/type snapshot reviewed; package tarball contains only intended entrypoints.
- SSR, iframe, multi-root, and shadow-root scope fixtures pass without global singleton state.

## Exit gate

There is one public controller contract and no legacy behavior path. Event cancellation, parts invariants, lifecycle, and environment behavior are proven with negative fixtures.

## Do not

- Do not add deprecated aliases/shims.
- Do not implement framework-local workarounds for missing controller capabilities.
- Do not put DOM operations in core.

## Handoff

Phase report lists all removed APIs and exact controller/part/environment interfaces consumed by `@uifn/dom` and adapters.
