# PLAN.md

## Architecture sketch
- `filefn/server`
  - fixes unresolved auth/idempotency/metadata bugs
  - adds logical storage-target support
  - adds render descriptor route
  - wires processing deterministically
- `filefn/client`
  - adds client-generated FileFn IDs
  - adds preprocessing pipeline and HEIC conversion
  - adds artifact and render resolution APIs
  - upgrades OPFS staging to support immediate local preview
- `filefn/processing`
  - keeps image thumbnail processor
  - adds PDF preview processor and canonical artifact kinds
- `filefn/viewer`
  - new framework-agnostic viewer resolution package for renderable sources
- `packages/storage`
  - adds routed storage adapter plugin for logical target -> physical bucket routing
- `filefn/python`
  - reaches parity for all server/storage semantics in this bundle
- `nucleus`
  - adopts native FileFn IDs on write paths
  - adopts FileFn viewer/render resolution on read paths
  - uses migration compatibility only during cutover
- migration tooling
  - Nucleus export manifest
  - FileFn import/adopt manifest
  - Nucleus rewrite/cutover manifest

## Dependency graph
1. Fix unresolved TS/Python audit issues before layering new migration capabilities.
2. Add logical storage targets before migration/import work.
3. Add processing/pdf preview before viewer adoption so render routes have canonical artifacts.
4. Add client file ID + offline preview semantics before Nucleus write-path migration.
5. Add viewer package and render descriptor API before replacing Nucleus render flows.
6. Add migration scripts before deleting compatibility code.
7. Delete legacy Nucleus code only after migration verification and end-to-end smoke pass.

## Phases overview
| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| Phase 00 | Close unresolved TS audit failures and metadata bugs | stable auth/idempotency/metadata baseline | targeted TS tests, typecheck, build |
| Phase 01 | Reach Python parity for carried-forward and new server/storage semantics | Python wire/config/test parity | `python3 -m pytest`, import checks |
| Phase 02 | Add logical storage targets and routed multi-bucket adapter | plugin-based physical bucket routing | storage unit tests, FileFn integration tests |
| Phase 03 | Add processing/render artifact upgrades | TS wiring fix, PDF previews, canonical artifact kinds | processing tests, artifact auth tests |
| Phase 04 | Upgrade client upload/offline semantics | stable client file IDs, OPFS preview, HEIC preprocessing | client tests, browser contract tests |
| Phase 05 | Add render descriptor API and `@filefn/viewer` | canonical view model replacement | server/client/viewer tests |
| Phase 06 | Migrate Nucleus write paths to native FileFn IDs | no new legacy file resources on write | Nucleus targeted tests, manual product smoke |
| Phase 07 | Build deterministic legacy migration tooling | manifest export/import/rewrite pipeline | dry-run/apply integration tests |
| Phase 08 | Replace Nucleus read/render flows and complete cutover | FileFn viewer in production paths, dual-read then deletion prep | Nucleus smoke, migration smoke |
| Phase 09 | Final cleanup, docs, demo, and release proof | delete legacy code, final docs, demo coverage | full local verification matrix |

## Definition of Done
No phase is complete unless its verification steps pass, the referenced requirements are satisfied, and no previously green FileFn or Nucleus behavior required by this spec regresses.
