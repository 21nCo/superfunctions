# Plan

## Architecture sketch

### Contract layer

1. Add one canonical contract module per language for:
   - error codes and error classes
   - provider ID normalization and alias maps
   - shared config normalization
   - router envelope helpers
2. Freeze the public package identity:
   - TypeScript package name `browsefn`
   - Python package name `browsefn`
   - synchronized versions and license metadata

### Execution layer

1. TypeScript:
   - `src/core/*` owns orchestration only
   - `src/web/*`, `src/images/*`, `src/geo/*` own domain behavior
   - `src/router/http-router.ts` owns HTTP translation only
   - rate limiting delegates algorithm logic to `@superfunctions/middleware/rate-limit`
2. Python:
   - `browsefn/core/*` owns orchestration only
   - `browsefn/web/*`, `browsefn/images/*`, `browsefn/geo/*` own domain behavior
   - `browsefn/http/router.py` owns HTTP translation only
   - router keeps using `superfunctions.http`

### Support layer

1. Cache backends:
   - memory
   - IndexedDB
   - file
   - database
2. Observability:
   - metrics collector
   - structured logger
   - event emitter
3. Verification:
   - TypeScript build/typecheck/tests
   - Python compile/tests
   - docs portability scan
   - duplication gate

## Dependency graph

1. Contract alignment comes first:
   - package identity
   - canonical provider IDs
   - canonical errors and router envelopes
2. Shared infrastructure comes second:
   - TypeScript shared rate limiter integration
   - cache normalization
   - observability wiring
3. Feature surfaces come third:
   - web
   - images
   - geo
4. Python parity comes after the contract is stable so both languages converge on the same semantics.
5. Docs, examples, duplication cleanup, and the final release gate come last.

## Phases overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| 00 | Align public contract and shared foundations | package identity, canonical provider IDs, canonical errors, version/license sync | metadata scans + package/version checks |
| 01 | Harden TypeScript core behavior | buildable TS package, shared rate limit wrapper, cache/retry/metrics/logging/event wiring, canonical router envelopes | `npm --prefix browsefn/typescript run build && npm --prefix browsefn/typescript run typecheck` |
| 02 | Complete TypeScript web retrieval | working `getPage`, batch metadata, custom scrape, Firecrawl/Jina support | TS web tests |
| 03 | Complete TypeScript image surface | normalized image search, real downloads, batch downloads, overwrite safety | TS image tests |
| 04 | Complete TypeScript geo surface | normalized geocode/search/details across providers | TS geo tests |
| 05 | Restore Python core parity | valid Python models, cache/rate-limit/retry/observability wiring, version parity | `python3 -m compileall` + Python core tests |
| 06 | Complete Python web/image/geo/router | typed router conversions and public Python feature parity | Python API tests |
| 07 | Fix docs, examples, and portability | accurate READMEs, quickstart, testing guide, examples, no machine-specific paths | docs portability scan |
| 08 | Reduce duplication and reuse shared packages | shared-package adoption complete and repeated logic extracted once per language | `npx jscpd ...` |
| 09 | Run the production release gate | full local verification pass for BrowseFn and release-readiness evidence for `nucleus` | full verification suite |

## Definition of Done

No phase is complete unless its verification steps pass.

The spec is complete only when:

1. All P0 requirements pass their referenced test vectors.
2. BrowseFn TypeScript and Python packages expose one internally consistent public contract.
3. The router surfaces emit only the canonical success and error envelopes.
4. Shared-package reuse and duplication goals are satisfied.
5. The documented repo-root verification suite passes without manual patching.
