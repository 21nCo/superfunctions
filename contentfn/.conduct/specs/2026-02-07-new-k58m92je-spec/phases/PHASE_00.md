# PHASE_00: Core scaffolding (types + validators + storage schema)

## Phase goal

Establish the core package layout and implement canonical types/envelopes/errors plus deterministic validators/helpers and a storage schema/migration baseline.

## In scope

- Package scaffolding for:
  - `contentfn/core` (`@contentfn/core`)
  - `contentfn/server` (`@contentfn/server`)
  - `contentfn/client` (`@contentfn/client`) (types-only in this phase)
- Canonical types in `@contentfn/core`:
  - `ContentfnErrorCode`, `ContentfnError`, `ContentfnEnvelope<T>`
  - schema types (`ContentfnSchema`, `ContentfnDocumentType`, fields)
  - document system fields + reference/asset canonical encodings
  - CFQL types + validators
  - patch op types + validators
- Deterministic helper utilities:
  - dataset name validation
  - ISO time helpers (server time only; no clock injection required yet)
  - cursor encoding/decoding interface (implementation deferred to PHASE_06 but shape defined)
- Storage schema definitions and/or migration runner for `@contentfn/server`:
  - datasets registry
  - schema storage
  - documents (draft + published)
  - revisions
  - assets metadata
  - events log
  - webhooks registrations + queue (tables can be stubbed, but schemas must exist)

## Out of scope

- HTTP server routes
- Any CRUD behavior
- Webhooks delivery runtime
- Realtime transport
- Import/export runtime

## Deliverables

- `contentfn/core/package.json`
- `contentfn/core/tsconfig.json`
- `contentfn/core/src/index.ts`
- `contentfn/core/src/errors.ts`
- `contentfn/core/src/envelope.ts`
- `contentfn/core/src/schema/types.ts`
- `contentfn/core/src/schema/validateSchema.ts`
- `contentfn/core/src/query/types.ts`
- `contentfn/core/src/query/validateCfql.ts`
- `contentfn/core/src/patch/types.ts`
- `contentfn/core/src/patch/validatePatch.ts`
- `contentfn/core/src/ids/datasetName.ts`
- `contentfn/server/package.json`
- `contentfn/server/tsconfig.json`
- `contentfn/server/src/storage/schema.ts` (adapter-agnostic schema mapping)
- `contentfn/server/src/storage/migrate.ts` (optional migration runner)
- `contentfn/client/package.json` (optional in this phase; may be created as placeholder)
- `contentfn/client/src/index.ts` exporting types (or re-exporting from core)

## Requirements covered

- API-001 (surface types and config shape; partial)
- API-002 (envelope/error model)
- DS-001 (dataset name validation; partial)
- SCHEMA-001 (schema validation; partial)
- QRY-001 (CFQL validation; partial)
- PATCH-001 (patch validation; partial)
- LIMIT-001 (limit constant definitions; partial)

## Implementation tasks

1. Create package scaffolds with ESM-first config (match repo conventions).
2. Implement errors/envelope types in `@contentfn/core` exactly as in `SPEC.md`.
3. Implement deterministic schema validator:
   - unique type names
   - unique field names per object/type
   - reference targets exist
   - validation rule shapes are well-formed
4. Implement deterministic CFQL validator:
   - operator allowlist
   - filter depth limit parameter (wired to config later)
   - orderBy validation
   - projection validation (field names)
5. Implement deterministic patch validator:
   - op allowlist
   - required fields per op
   - path syntax validation (string non-empty + allowed chars; exact grammar defined in code)
6. Define storage schema objects/DDL targets for all required tables (see PLAN.md).
7. Add unit tests for validators using fixture inputs from `TEST_VECTORS.md` (schema invalid duplicate type; query invalid operator; patch invalid path).

## Verification steps

- `npm run build` at repo root (or `turbo run build --filter=@contentfn/*`) succeeds.
- `npm test` (or `turbo run test --filter=@contentfn/*`) runs validator unit tests:
  - schema invalid duplicate type is rejected
  - query invalid operator is rejected
  - patch invalid path is rejected

## Stop condition

- Core types compile, validators behave deterministically, and storage schema definition exists for all required entities.

