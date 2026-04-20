# PlugFn Status

**Version**: 0.0.1  
**Date**: 2026-03-27  
**Status**: Phase 08 release gating is in place; PlugFn readiness is matrix-bounded and only valid on commits where the repo-root gate passes.

## Readiness rule

PlugFn may only be described as production-ready when both conditions are true:

1. `npm run gate:plugfn-release` passes on the same commit, as described in [../docs/operations/release-gates.md](../docs/operations/release-gates.md)
2. the specific provider or runtime surface is marked `production` in [../docs/provider-readiness-matrix.md](../docs/provider-readiness-matrix.md)

Until then, readiness claims must remain provider-specific and bounded. PlugFn still does not make blanket production-ready claims across every provider or vertical module.

## Current product contract

PlugFn is the shared integration runtime for Superfunctions apps. Its default scope is:

- provider registration
- connection lifecycle
- OAuth and webhook route exposure
- workflow execution

Mail-specific or app-specific modules remain optional vertical surfaces and are not the default production contract.

## Package contract

- TypeScript runtime: `plugfn`
- CLI: `@plugfn/cli`
- Python package: `plugfn` (experimental)

## Core provider set tracked by the release gate

- `github`
- `linear`
- `clickup`
- `gmail`

See [../docs/provider-readiness-matrix.md](../docs/provider-readiness-matrix.md) for the current per-provider TypeScript and Python truth.

## Language status

### TypeScript

- reference runtime
- broadest current provider surface
- covered by the repo-root release gate for the declared production matrix surface

### Python

- core provider set is covered by the repo-root release gate
- still narrower than TypeScript outside the declared core set
- broader parity beyond the matrix-marked core providers is not claimed
- production wording remains matrix-bounded and same-commit gate-bound

## Phase map

- Phase 00: contract reset, package truth, provider matrix, client boundary
- Phase 01: shared DB contract and first-class OAuth storage
- Phase 02: TypeScript OAuth migration and thin legacy shim
- Phase 03: route auth and raw-body webhook hardening
- Phase 04: workflow lifecycle correctness and CLI diagnostics
- Phase 05: Python importability and docs truth
- Phase 06: Python auth and webhook security parity
- Phase 07: Python core provider parity
- Phase 08: repo-root release gate complete
