# PHASE_03 — Private behavior/effect runtime

## Objective

Implement one private, deterministic UI behavior runtime that replaces the current shallow generic machine/local-store semantics.

## Entry

- Phase 02 catalog compiler and behavior schema pass.
- Runtime public/private boundary and snapshot/change metadata contracts in `SPEC.md` are type-reviewed.

## Requirements

- `ARCH-001`, `CORE-001`, `CORE-002`, `CORE-003`, `CORE-004`.

## Work

1. Implement the private service runtime under non-exported `uifn/core/src/internal/` modules: typed event FIFO, guards/reducers, immutable versioned snapshots, computed state, validated reactive inputs, context, refs, instance scope, status, and subscriptions.
2. Implement deterministic effect/activity/child-service lifecycle with cancellation, abort signals, timers/scheduler, observer/resource registration, stale-work suppression, and recursive destroy.
3. Implement typed change metadata, stable public-facing error codes, development/test semantic traces, redaction, and production dead-code stripping for debug facilities.
4. Add reference models and property tests for event sequences, reentrancy, no-op/change publication, input updates, effect order, destroy, child failure, and cross-scope isolation.
5. Add static/package checks proving there is one private constructor and no runtime internal export/declaration path.

## Required evidence

- `TV-ARCH-001-P/N` and `TV-CORE-001-P/N` through `TV-CORE-004-P/N`.
- Property failures retain seed/minimized case; lifecycle evidence reaches zero resources.
- Core imports and executes under Node 20/22/24 without a DOM.

## Exit gate

Runtime semantics are deterministic and mutation-tested, internals remain private, and the runtime can support all catalog behavior families without framework dependencies.

## Do not

- Do not expose machine definitions/services as public API.
- Do not migrate public controllers or primitives beyond small private fixtures.
- Do not add framework or DOM dependencies to core.

## Handoff

Phase report documents invariants, queue/effect ordering, trace/error schemas, measured baseline overhead, and controller integration points.
